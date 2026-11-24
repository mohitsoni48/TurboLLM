use crate::cpu::{CpuFeatures, cpu_features_from_cpuinfo, read_cpuinfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Android,
    Linux,
    Windows,
    MacOs,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    Aarch64,
    Arm,
    X86_64,
    X86,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFacts {
    pub os: Os,
    pub arch: Arch,
    pub cpu: CpuFeatures,
}

impl HostFacts {
    /// OS and architecture are fixed at compile time; the CPU features are read now.
    pub fn detect() -> HostFacts {
        HostFacts {
            os: Os::CURRENT,
            arch: Arch::CURRENT,
            cpu: cpu_features_from_cpuinfo(&read_cpuinfo()),
        }
    }
}

impl Os {
    #[cfg(target_os = "android")]
    const CURRENT: Os = Os::Android;
    #[cfg(target_os = "linux")]
    const CURRENT: Os = Os::Linux;
    #[cfg(target_os = "windows")]
    const CURRENT: Os = Os::Windows;
    #[cfg(target_os = "macos")]
    const CURRENT: Os = Os::MacOs;
    #[cfg(target_os = "ios")]
    const CURRENT: Os = Os::Ios;
}

impl Arch {
    #[cfg(target_arch = "aarch64")]
    const CURRENT: Arch = Arch::Aarch64;
    #[cfg(target_arch = "arm")]
    const CURRENT: Arch = Arch::Arm;
    #[cfg(target_arch = "x86_64")]
    const CURRENT: Arch = Arch::X86_64;
    #[cfg(target_arch = "x86")]
    const CURRENT: Arch = Arch::X86;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn the_os_is_the_one_this_was_compiled_for() {
        assert_eq!(HostFacts::detect().os, Os::Windows);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_os_is_the_one_this_was_compiled_for() {
        assert_eq!(HostFacts::detect().os, Os::Linux);
    }

    #[cfg(target_os = "android")]
    #[test]
    fn the_os_is_the_one_this_was_compiled_for() {
        assert_eq!(HostFacts::detect().os, Os::Android);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_os_is_the_one_this_was_compiled_for() {
        assert_eq!(HostFacts::detect().os, Os::MacOs);
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn the_arch_is_the_one_this_was_compiled_for() {
        assert_eq!(HostFacts::detect().arch, Arch::X86_64);
    }

    #[cfg(target_arch = "aarch64")]
    #[test]
    fn the_arch_is_the_one_this_was_compiled_for() {
        assert_eq!(HostFacts::detect().arch, Arch::Aarch64);
    }

    #[test]
    fn the_cpu_features_come_from_this_hosts_cpuinfo() {
        assert_eq!(
            HostFacts::detect().cpu,
            cpu_features_from_cpuinfo(&read_cpuinfo())
        );
    }
}
