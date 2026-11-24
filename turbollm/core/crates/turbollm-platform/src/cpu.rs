use std::collections::BTreeSet;

/// The CPU features that every core lists, so code built for them runs on whichever core the OS picks.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CpuFeatures(BTreeSet<String>);

impl CpuFeatures {
    pub fn contains(&self, feature: &str) -> bool {
        self.0.contains(feature)
    }
}

/// Port of `CpuVariant.kt:36-41`: the intersection of every core's `Features` line. A cpuinfo with
/// no such line (x86, or an unreadable file) has no features, so only the base build is chosen.
pub fn cpu_features_from_cpuinfo(text: &str) -> CpuFeatures {
    let features_on_every_core = text
        .lines()
        .filter_map(features_of_core)
        .reduce(|common, core| common.intersection(&core).cloned().collect())
        .unwrap_or_default();
    CpuFeatures(features_on_every_core)
}

/// `/proc/cpuinfo`, or `""` when unreadable or off Linux (`LlamaBinding.kt:64-69`).
pub fn read_cpuinfo() -> String {
    if cfg!(any(target_os = "linux", target_os = "android")) {
        std::fs::read(CPUINFO)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    } else {
        String::new()
    }
}

const CPUINFO: &str = "/proc/cpuinfo";

fn features_of_core(line: &str) -> Option<BTreeSet<String>> {
    let (key, value) = line.split_once(':')?;
    (key.trim() == "Features").then(|| value.split_whitespace().map(str::to_owned).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARMV80: &str = include_str!("../../../fixtures/cpuinfo/armv80.txt");
    const ARMV9: &str = include_str!("../../../fixtures/cpuinfo/armv9.txt");
    const S21FE: &str = include_str!("../../../fixtures/cpuinfo/s21fe.txt");
    const X86: &str = include_str!("../../../fixtures/cpuinfo/x86.txt");

    #[test]
    fn an_armv9_core_with_i8mm_has_i8mm_and_dotprod() {
        let features = cpu_features_from_cpuinfo(ARMV9);

        assert!(features.contains("i8mm"));
        assert!(features.contains("asimddp"));
    }

    #[test]
    fn the_s21_fe_has_dotprod_but_no_i8mm() {
        let features = cpu_features_from_cpuinfo(S21FE);

        assert!(features.contains("asimddp"));
        assert!(!features.contains("i8mm"));
    }

    #[test]
    fn a_plain_armv80_core_has_neither_dotprod_nor_i8mm() {
        let features = cpu_features_from_cpuinfo(ARMV80);

        assert!(features.contains("asimd"));
        assert!(!features.contains("asimddp"));
        assert!(!features.contains("i8mm"));
    }

    #[test]
    fn an_x86_cpu_has_no_features_line_and_no_features() {
        assert_eq!(cpu_features_from_cpuinfo(X86), CpuFeatures::default());
    }

    #[test]
    fn features_are_matched_as_whole_words_not_substrings() {
        let features = cpu_features_from_cpuinfo("Features\t: fp asimd asimddp svei8mm\n");

        assert!(features.contains("svei8mm"));
        assert!(!features.contains("i8mm"));
    }

    #[test]
    fn i8mm_without_dotprod_is_read_as_i8mm_alone() {
        let features = cpu_features_from_cpuinfo("Features\t: fp asimd i8mm\n");

        assert!(features.contains("i8mm"));
        assert!(!features.contains("asimddp"));
    }

    #[test]
    fn a_feature_missing_on_any_core_is_not_used() {
        let mixed_cores = "Features\t: fp asimd asimddp i8mm\n\nFeatures\t: fp asimd asimddp\n";

        let features = cpu_features_from_cpuinfo(mixed_cores);

        assert!(features.contains("asimddp"));
        assert!(!features.contains("i8mm"));
    }

    #[test]
    fn one_core_of_eight_without_dotprod_takes_dotprod_away() {
        let dotprod_core = "Features\t: fp asimd asimddp\n\n";
        let mixed_cores = format!("{}Features\t: fp asimd\n", dotprod_core.repeat(7));

        assert!(!cpu_features_from_cpuinfo(&mixed_cores).contains("asimddp"));
    }

    #[test]
    fn an_unreadable_cpuinfo_has_no_features() {
        assert_eq!(cpu_features_from_cpuinfo(""), CpuFeatures::default());
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    #[test]
    fn off_linux_there_is_no_cpuinfo() {
        assert_eq!(read_cpuinfo(), "");
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn on_linux_cpuinfo_lists_the_processors() {
        assert!(read_cpuinfo().contains("processor"));
    }
}
