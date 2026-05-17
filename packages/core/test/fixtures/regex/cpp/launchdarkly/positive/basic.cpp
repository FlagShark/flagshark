#include <launchdarkly/server_side/client.hpp>

int Checkout(launchdarkly::Client& client, launchdarkly::Context& context) {
    bool enabled = client.BoolVariation(context, "CHECKOUT_V2", false);
    if (enabled) {
        return 2;
    }
    return 1;
}
