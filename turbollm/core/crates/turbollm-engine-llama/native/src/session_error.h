#pragma once

#include <stdexcept>
#include <string>

namespace turbollm {

// The values are the sentinels the JNI layer returns, so Kotlin can tell the failures apart.
enum class session_failure : int {
    failed                  = -1,
    context_length_exceeded = -2,
    template_unsupported    = -3,
    aborted                 = -4,
};

class session_error : public std::runtime_error {
public:
    session_error(session_failure failure, const std::string & message)
        : std::runtime_error(message), failure_(failure) {}

    session_failure failure() const noexcept { return failure_; }

private:
    session_failure failure_;
};

}  // namespace turbollm
