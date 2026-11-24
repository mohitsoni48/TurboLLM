//! Pure facts about the host the engines run on: OS and architecture, the CPU features every core
//! has, the default inference thread count, and where a shared library is found. Nothing here keeps
//! global mutable state (B-5): every call reads the host afresh.

mod cpu;
mod dylib;
mod host;
mod threads;

pub use cpu::{CpuFeatures, cpu_features_from_cpuinfo, read_cpuinfo};
pub use dylib::{library_candidates, library_file_name};
pub use host::{Arch, HostFacts, Os};
pub use threads::{default_thread_count, max_frequencies_khz, thread_count_for};
