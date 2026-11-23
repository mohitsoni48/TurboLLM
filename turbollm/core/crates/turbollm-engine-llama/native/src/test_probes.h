#pragma once

// Debug builds only (TURBOLLM_TEST_PROBES): native state a device test can observe through the
// androidTest-only LlamaTestProbe, and nothing a release build contains.

namespace turbollm {

// Counts the llama_session objects that exist. A session holds one as its first member, so the
// count drops only after the rest of the session, its model included, has been freed.
class live_session_count {
public:
    live_session_count() noexcept;
    ~live_session_count();

    live_session_count(const live_session_count &)             = delete;
    live_session_count & operator=(const live_session_count &) = delete;

    static int current() noexcept;
};

}  // namespace turbollm
