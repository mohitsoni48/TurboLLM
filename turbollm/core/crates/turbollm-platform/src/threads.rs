use std::fs;
use std::path::Path;

const MAX_THREADS: u32 = 8;
const CPU_ROOT: &str = "/sys/devices/system/cpu";

/// The default llama.cpp thread count: the performance cores, clamped to 1..=8 (port of
/// `DeviceInfo.kt:13-34`). Off Linux no core speeds are read, so every available processor counts.
pub fn default_thread_count() -> u32 {
    thread_count_for(&host_max_frequencies_khz(), available_processors())
}

/// The cores faster than the slowest cluster, since a phone's efficiency cores slow a decode down
/// rather than speed it up. When every core runs at one speed, or none could be read, every
/// processor counts.
pub fn thread_count_for(max_freqs_khz: &[u64], processors: u32) -> u32 {
    performance_cores(max_freqs_khz, processors).clamp(1, MAX_THREADS)
}

/// Each core's `cpufreq/cpuinfo_max_freq` under `cpu_root`; a core without a readable one is left out.
pub fn max_frequencies_khz(cpu_root: &Path) -> Vec<u64> {
    let Ok(entries) = fs::read_dir(cpu_root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| is_core_folder(&entry.path()))
        .filter_map(|entry| max_frequency_of(&entry.path()))
        .collect()
}

fn host_max_frequencies_khz() -> Vec<u64> {
    if cfg!(any(target_os = "linux", target_os = "android")) {
        max_frequencies_khz(Path::new(CPU_ROOT))
    } else {
        Vec::new()
    }
}

fn available_processors() -> u32 {
    std::thread::available_parallelism().map_or(1, |n| u32::try_from(n.get()).unwrap_or(u32::MAX))
}

fn performance_cores(max_freqs_khz: &[u64], processors: u32) -> u32 {
    let Some(&slowest) = max_freqs_khz.iter().min() else {
        return processors;
    };
    let faster = max_freqs_khz.iter().filter(|&&khz| khz > slowest).count();
    let counted = if faster == 0 {
        max_freqs_khz.len()
    } else {
        faster
    };
    u32::try_from(counted).unwrap_or(u32::MAX)
}

fn is_core_folder(path: &Path) -> bool {
    let is_numbered_cpu = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("cpu"))
        .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()));
    is_numbered_cpu && path.is_dir()
}

fn max_frequency_of(core: &Path) -> Option<u64> {
    let text = fs::read_to_string(core.join("cpufreq").join("cpuinfo_max_freq")).ok()?;
    text.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn the_slowest_cluster_is_not_counted_as_performance_cores() {
        let little_cores = [1_800_000; 4];
        let big_cores = [2_400_000, 2_400_000, 2_400_000, 2_840_000];

        assert_eq!(thread_count_for(&[little_cores, big_cores].concat(), 8), 4);
    }

    #[test]
    fn cores_that_all_run_at_the_same_speed_all_count() {
        assert_eq!(thread_count_for(&[2_000_000; 4], 4), 4);
    }

    #[test]
    fn the_thread_count_is_at_most_eight() {
        let big_server_like_chip = [vec![3_000_000; 10], vec![1_000_000; 2]].concat();

        assert_eq!(thread_count_for(&big_server_like_chip, 12), 8);
    }

    #[test]
    fn without_frequencies_every_processor_counts_up_to_eight() {
        assert_eq!(thread_count_for(&[], 2), 2);
        assert_eq!(thread_count_for(&[], 16), 8);
    }

    #[test]
    fn the_thread_count_is_at_least_one() {
        assert_eq!(thread_count_for(&[], 0), 1);
    }

    #[test]
    fn each_cores_maximum_frequency_is_read_from_sysfs_and_other_folders_are_skipped() {
        let sysfs = TempDir::new().unwrap();
        write_core(&sysfs, "cpu0", "1800000\n");
        write_core(&sysfs, "cpu1", "1800000\n");
        write_core(&sysfs, "cpu10", "2840000\n");
        write_core(&sysfs, "cpufreq", "999");
        fs::create_dir(sysfs.path().join("cpuidle")).unwrap();

        let mut frequencies = max_frequencies_khz(sysfs.path());
        frequencies.sort_unstable();

        assert_eq!(frequencies, [1_800_000, 1_800_000, 2_840_000]);
    }

    #[test]
    fn a_core_without_a_readable_frequency_is_left_out() {
        let sysfs = TempDir::new().unwrap();
        write_core(&sysfs, "cpu0", "1800000");
        fs::create_dir(sysfs.path().join("cpu1")).unwrap();
        write_core(&sysfs, "cpu2", "not a number");

        assert_eq!(max_frequencies_khz(sysfs.path()), [1_800_000]);
    }

    #[test]
    fn a_missing_cpu_folder_gives_no_frequencies() {
        let sysfs = TempDir::new().unwrap();

        assert!(max_frequencies_khz(&sysfs.path().join("absent")).is_empty());
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    #[test]
    fn off_linux_the_default_is_the_available_parallelism_up_to_eight() {
        let parallelism = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);

        assert_eq!(default_thread_count(), parallelism.clamp(1, 8));
    }

    #[test]
    fn the_default_thread_count_is_between_one_and_eight() {
        assert!((1..=8).contains(&default_thread_count()));
    }

    fn write_core(sysfs: &TempDir, name: &str, max_frequency: &str) {
        let cpufreq = sysfs.path().join(name).join("cpufreq");
        fs::create_dir_all(&cpufreq).unwrap();
        fs::write(cpufreq.join("cpuinfo_max_freq"), max_frequency).unwrap();
    }
}
