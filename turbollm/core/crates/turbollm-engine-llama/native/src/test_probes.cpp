#include "test_probes.h"

#include <jni.h>

#include <atomic>

namespace turbollm {

namespace {

std::atomic<int> live_sessions{ 0 };

}  // namespace

live_session_count::live_session_count() noexcept {
    live_sessions.fetch_add(1);
}

live_session_count::~live_session_count() {
    live_sessions.fetch_sub(1);
}

int live_session_count::current() noexcept {
    return live_sessions.load();
}

}  // namespace turbollm

extern "C" JNIEXPORT jint JNICALL Java_dev_turbollm_sdk_engine_llama_LlamaTestProbe_liveSessions(JNIEnv *, jobject) {
    return turbollm::live_session_count::current();
}
