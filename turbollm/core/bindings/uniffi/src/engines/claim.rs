//! A claimed load as Kotlin holds it (arch 3.3, T-4): the lifecycle is held from `claim_load` until `run`
//! ends, or the claim is abandoned or destroyed.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use turbollm_core::engines::Engines;
use turbollm_engine::{EngineError, LoadClaim};

use crate::engines::dto::CoreLoadedModel;
use crate::engines::engines::on_core;
use crate::engines::failure::CoreEngineException;

#[derive(uniffi::Object)]
pub struct CoreLoadClaim {
    engines: Arc<Engines>,
    claim: Mutex<Option<LoadClaim>>,
}

#[uniffi::export]
impl CoreLoadClaim {
    /// Runs the load once; a second run is refused as `Closed`.
    pub async fn run(&self) -> Result<CoreLoadedModel, CoreEngineException> {
        let claim = self.claim().take().ok_or(EngineError::Closed)?;
        let loaded = on_core(&self.engines, claim.run()).await?;
        Ok(loaded.into())
    }

    /// Releases the lifecycle without loading; idempotent.
    pub fn abandon(&self) {
        drop(self.claim().take());
    }
}

impl CoreLoadClaim {
    pub(crate) fn new(engines: Arc<Engines>, claim: LoadClaim) -> CoreLoadClaim {
        CoreLoadClaim {
            engines,
            claim: Mutex::new(Some(claim)),
        }
    }

    fn claim(&self) -> MutexGuard<'_, Option<LoadClaim>> {
        self.claim.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
