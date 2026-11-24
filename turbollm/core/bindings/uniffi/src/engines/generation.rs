//! A generation Kotlin pulls from (arch 8: pull, never push): `next` suspends until the next event, and a
//! cancelled Kotlin coroutine simply drops the `next` future. `cancel` reaches the engine from any thread,
//! even while a `next` is suspended.

use turbollm_engine::{Generation, GenerationCanceller};

use crate::engines::dto::CoreEngineEvent;
use crate::engines::failure::CoreEngineException;

#[derive(uniffi::Object)]
pub struct CoreGeneration {
    generation: tokio::sync::Mutex<Generation>,
    canceller: GenerationCanceller,
}

#[uniffi::export]
impl CoreGeneration {
    /// The next event; `None` after `Done`.
    pub async fn next(&self) -> Result<Option<CoreEngineEvent>, CoreEngineException> {
        let mut generation = self.generation.lock().await;
        let event = generation.next().await?;
        Ok(event.map(CoreEngineEvent::from))
    }

    /// Asks the engine to stop the reply; idempotent, from any thread.
    pub fn cancel(&self) {
        self.canceller.cancel();
    }
}

impl CoreGeneration {
    pub(crate) fn new(generation: Generation) -> CoreGeneration {
        CoreGeneration {
            canceller: generation.canceller(),
            generation: tokio::sync::Mutex::new(generation),
        }
    }
}
