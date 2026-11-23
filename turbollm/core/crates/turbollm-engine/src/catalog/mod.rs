//! The engines a build hosts, in preference order, and which of them can run here (port of the
//! SDK's `EngineCatalog.kt`). Resolving a model to an engine follows ADR-462 (`resolve.rs`).

mod data;
mod resolve;

use std::collections::BTreeMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use turbollm_platform::{HostFacts, Os};

use crate::descriptor::{Availability, EngineDescriptor};
use crate::engine::Engine;
use crate::ids::EngineId;
use crate::inprocess::panic_message;

const PROBE_PANIC_WITHOUT_MESSAGE: &str = "The engine's availability check panicked.";

/// The engines this build hosts, first to last in preference order.
pub struct Catalog {
    entries: Vec<CatalogEntry>,
    runtime_failures: Mutex<BTreeMap<EngineId, String>>,
    forced: BTreeMap<EngineId, String>,
    host: HostFacts,
}

/// One engine compiled into this build, with how it runs on each platform.
pub struct CatalogEntry {
    pub descriptor: EngineDescriptor,
    pub per_platform: PlatformKinds,
    pub engine: Arc<dyn Engine>,
}

/// How an engine runs on one platform (roadmap legend IP / SP / -).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformKind {
    InProcess,
    Supervised,
    Unsupported(&'static str),
}

/// One `PlatformKind` per platform the core builds for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlatformKinds {
    pub android: PlatformKind,
    pub ios: PlatformKind,
    pub linux: PlatformKind,
    pub windows: PlatformKind,
    pub mac_os: PlatformKind,
}

impl PlatformKinds {
    pub fn on(&self, os: Os) -> PlatformKind {
        match os {
            Os::Android => self.android,
            Os::Ios => self.ios,
            Os::Linux => self.linux,
            Os::Windows => self.windows,
            Os::MacOs => self.mac_os,
        }
    }
}

impl Catalog {
    /// An empty catalogue for `host`; entries are added in preference order.
    pub fn new(host: HostFacts) -> Catalog {
        Catalog {
            entries: Vec::new(),
            runtime_failures: Mutex::new(BTreeMap::new()),
            forced: BTreeMap::new(),
            host,
        }
    }

    /// Adds `entry` last, or puts it in the place of the entry with the same id.
    pub fn with_entry(mut self, entry: CatalogEntry) -> Catalog {
        let same_id = self
            .entries
            .iter_mut()
            .find(|held| held.descriptor.id == entry.descriptor.id);
        match same_id {
            Some(held) => *held = entry,
            None => self.entries.push(entry),
        }
        self
    }

    /// Makes `id` unavailable for `reason` (debug faults the host passes in).
    pub fn with_forced_unavailable(mut self, id: EngineId, reason: String) -> Catalog {
        self.forced.insert(id, reason);
        self
    }

    /// The engines that run in-process here, with whether each can run now: the SDK's list.
    pub fn hosted(&self) -> Vec<(EngineDescriptor, Availability)> {
        self.hosted_entries()
            .map(|entry| (entry.descriptor.clone(), self.availability_of(entry)))
            .collect()
    }

    /// An engine failed to start at runtime; it stays unavailable for the rest of this catalogue's life.
    pub fn mark_unavailable(&self, id: &EngineId, reason: String) {
        self.runtime_failures().insert(id.clone(), reason);
    }

    /// Only these entries exist for listing and routing; the others run some other way, or not here.
    fn hosted_entries(&self) -> impl Iterator<Item = &CatalogEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.per_platform.on(self.host.os) == PlatformKind::InProcess)
    }

    fn availability_of(&self, entry: &CatalogEntry) -> Availability {
        match self.why_unavailable(entry) {
            Some(reason) => Availability::Unavailable { reason },
            None => Availability::Available,
        }
    }

    /// A runtime failure, else a forced reason, else what the engine's probe says (`EngineCatalog.kt:88-95`).
    fn why_unavailable(&self, entry: &CatalogEntry) -> Option<String> {
        let id = &entry.descriptor.id;
        let runtime_failure = self.runtime_failures().get(id).cloned();
        runtime_failure
            .or_else(|| self.forced.get(id).cloned())
            .or_else(|| self.probe(entry))
    }

    fn probe(&self, entry: &CatalogEntry) -> Option<String> {
        panic::catch_unwind(AssertUnwindSafe(|| entry.engine.probe(&self.host)))
            .unwrap_or_else(|payload| Some(panic_message(payload, PROBE_PANIC_WITHOUT_MESSAGE)))
    }

    fn runtime_failures(&self) -> MutexGuard<'_, BTreeMap<EngineId, String>> {
        self.runtime_failures
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::descriptor::Backend;
    use crate::ids::{EngineKind, ModelFormat};
    use crate::inprocess::InProcess;
    use crate::testing::{ScriptedBackend, ScriptedProbe as Probe};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use turbollm_platform::{Arch, CpuFeatures};

    pub(crate) fn host(os: Os) -> HostFacts {
        HostFacts {
            os,
            arch: Arch::Aarch64,
            cpu: CpuFeatures::default(),
        }
    }

    pub(crate) fn passing() -> Probe {
        Box::new(|| None)
    }

    pub(crate) fn failing(reason: &'static str) -> Probe {
        Box::new(move || Some(reason.to_owned()))
    }

    pub(crate) fn engine_probing(probe: Probe) -> Arc<dyn Engine> {
        Arc::new(InProcess::new(
            ScriptedBackend::new(Vec::new()).with_probe(probe),
        ))
    }

    /// The SDK's two engines on an Android host, each answering its probe with the given closure.
    pub(crate) fn sdk_catalog(llama_cpp_probe: Probe, litert_lm_probe: Probe) -> Catalog {
        Catalog::new(host(Os::Android))
            .with_entry(CatalogEntry::llama_cpp_cpu(engine_probing(llama_cpp_probe)))
            .with_entry(CatalogEntry::litert_lm(engine_probing(litert_lm_probe)))
    }

    pub(crate) fn id(id: &str) -> EngineId {
        EngineId::new(id)
    }

    fn availabilities(catalog: &Catalog) -> Vec<Availability> {
        catalog
            .hosted()
            .into_iter()
            .map(|(_, availability)| availability)
            .collect()
    }

    fn unavailable(reason: &str) -> Availability {
        Availability::Unavailable {
            reason: reason.to_owned(),
        }
    }

    fn counting(count: &Arc<AtomicUsize>) -> Probe {
        let count = Arc::clone(count);
        Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            None
        })
    }

    #[test]
    fn lists_the_engines_in_preference_order_with_what_each_reads_and_runs_on() {
        let expected = vec![
            (
                EngineDescriptor {
                    id: id(EngineId::LLAMA_CPP_CPU),
                    name: "llama.cpp (CPU)".to_owned(),
                    kind: EngineKind::LlamaCpp,
                    formats: vec![ModelFormat::Gguf],
                    backends: vec![Backend::Cpu],
                },
                Availability::Available,
            ),
            (
                EngineDescriptor {
                    id: id(EngineId::LITERT_LM),
                    name: "LiteRT-LM".to_owned(),
                    kind: EngineKind::LitertLm,
                    formats: vec![ModelFormat::Litertlm],
                    backends: vec![Backend::Gpu, Backend::Cpu],
                },
                Availability::Available,
            ),
        ];
        assert_eq!(sdk_catalog(passing(), passing()).hosted(), expected);
    }

    #[test]
    fn a_probe_that_gives_a_reason_makes_its_engine_unavailable() {
        let catalog = sdk_catalog(passing(), failing("No GPU here."));
        assert_eq!(
            availabilities(&catalog),
            vec![Availability::Available, unavailable("No GPU here.")]
        );
    }

    #[test]
    fn a_probe_that_panics_counts_as_unavailable_with_the_panic_message() {
        let catalog = sdk_catalog(Box::new(|| panic!("cpuinfo exploded")), passing());
        assert_eq!(availabilities(&catalog)[0], unavailable("cpuinfo exploded"));
    }

    #[test]
    fn a_probe_that_panics_with_a_formatted_message_reads_as_that_message() {
        let catalog = sdk_catalog(Box::new(|| panic!("cpuinfo has {} cores", 8)), passing());
        assert_eq!(
            availabilities(&catalog)[0],
            unavailable("cpuinfo has 8 cores")
        );
    }

    #[test]
    fn a_probe_that_panics_without_a_message_still_gives_a_reason() {
        let catalog = sdk_catalog(Box::new(|| std::panic::panic_any(42_u32)), passing());
        assert_eq!(
            availabilities(&catalog)[0],
            unavailable("The engine's availability check panicked.")
        );
    }

    #[test]
    fn an_engine_marked_unavailable_stays_unavailable_for_listing() {
        let catalog = sdk_catalog(passing(), passing());
        catalog.mark_unavailable(
            &id(EngineId::LITERT_LM),
            "The LiteRT-LM library did not link.".to_owned(),
        );
        assert_eq!(
            availabilities(&catalog)[1],
            unavailable("The LiteRT-LM library did not link.")
        );
        assert_eq!(
            availabilities(&catalog)[1],
            unavailable("The LiteRT-LM library did not link.")
        );
    }

    #[test]
    fn each_listing_runs_each_probe_once_and_remembers_nothing_but_runtime_failures() {
        let llama_probes = Arc::new(AtomicUsize::new(0));
        let litert_probes = Arc::new(AtomicUsize::new(0));
        let catalog = sdk_catalog(counting(&llama_probes), counting(&litert_probes));

        catalog.hosted();
        catalog.hosted();
        catalog.mark_unavailable(&id(EngineId::LITERT_LM), "gone".to_owned());
        catalog.hosted();

        assert_eq!(llama_probes.load(Ordering::SeqCst), 3);
        assert_eq!(litert_probes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_forced_reason_beats_a_passing_probe() {
        let catalog = sdk_catalog(passing(), passing())
            .with_forced_unavailable(id(EngineId::LITERT_LM), "debug fault".to_owned());
        assert_eq!(availabilities(&catalog)[1], unavailable("debug fault"));
    }

    #[test]
    fn a_runtime_failure_beats_a_forced_reason() {
        let catalog = sdk_catalog(passing(), passing())
            .with_forced_unavailable(id(EngineId::LITERT_LM), "debug fault".to_owned());
        catalog.mark_unavailable(&id(EngineId::LITERT_LM), "did not link".to_owned());
        assert_eq!(availabilities(&catalog)[1], unavailable("did not link"));
    }

    #[test]
    fn a_forced_reason_spares_the_probe() {
        let probes = Arc::new(AtomicUsize::new(0));
        let catalog = sdk_catalog(passing(), counting(&probes))
            .with_forced_unavailable(id(EngineId::LITERT_LM), "debug fault".to_owned());
        catalog.hosted();
        assert_eq!(probes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_entry_with_the_id_of_an_earlier_one_replaces_it_in_its_place() {
        let foreign = CatalogEntry::llama_cpp_cpu(engine_probing(failing("foreign engine")));
        let catalog = sdk_catalog(passing(), passing()).with_entry(foreign);

        let hosted = catalog.hosted();
        assert_eq!(hosted.len(), 2);
        assert_eq!(hosted[0].0.id, id(EngineId::LLAMA_CPP_CPU));
        assert_eq!(hosted[0].1, unavailable("foreign engine"));
        assert_eq!(hosted[1].0.id, id(EngineId::LITERT_LM));
    }

    #[test]
    fn a_desktop_host_hosts_none_of_the_sdk_engines_in_2a() {
        for os in [Os::Linux, Os::Windows, Os::MacOs, Os::Ios] {
            let catalog = Catalog::new(host(os))
                .with_entry(CatalogEntry::llama_cpp_cpu(engine_probing(passing())))
                .with_entry(CatalogEntry::litert_lm(engine_probing(passing())));
            assert_eq!(catalog.hosted(), Vec::new(), "{os:?}");
        }
    }

    #[test]
    fn an_engine_not_in_process_here_is_never_probed() {
        let probes = Arc::new(AtomicUsize::new(0));
        let catalog = Catalog::new(host(Os::Windows)).with_entry(CatalogEntry::llama_cpp_cpu(
            engine_probing(counting(&probes)),
        ));
        catalog.hosted();
        assert_eq!(probes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn platform_kinds_answer_for_each_os() {
        let kinds = PlatformKinds {
            android: PlatformKind::InProcess,
            ios: PlatformKind::Unsupported("ios"),
            linux: PlatformKind::Supervised,
            windows: PlatformKind::Unsupported("windows"),
            mac_os: PlatformKind::Unsupported("mac"),
        };
        assert_eq!(kinds.on(Os::Android), PlatformKind::InProcess);
        assert_eq!(kinds.on(Os::Ios), PlatformKind::Unsupported("ios"));
        assert_eq!(kinds.on(Os::Linux), PlatformKind::Supervised);
        assert_eq!(kinds.on(Os::Windows), PlatformKind::Unsupported("windows"));
        assert_eq!(kinds.on(Os::MacOs), PlatformKind::Unsupported("mac"));
    }
}
