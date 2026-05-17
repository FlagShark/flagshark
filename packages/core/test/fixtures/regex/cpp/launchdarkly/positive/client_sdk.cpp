// Regression fixture for the Client SDK signature. Pre-fix, the C++ default
// provider had a single 'launchdarkly' importPattern with flagKeyIndex 1.
// Client SDK calls put the flag at index 0, so the scanner extracted the
// default value as a flag (false positive). Fix: separate Client / Server
// providers with distinct importPatterns and matching indexes.

#include <launchdarkly/client_side/client.hpp>

void Run(launchdarkly::client_side::Client& client) {
    bool ok = client.BoolVariation("client-feature-enabled", false);
    if (ok) {
        DoNew();
    }
    // Index-1 string literal must NOT be picked up as a flag.
    std::string apiVersion = client.StringVariation("client-api-version", "v1");
    auto detail = client.BoolVariationDetail("client-rollout-detail", false);
}
