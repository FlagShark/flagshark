import com.launchdarkly.sdk.server.LDClient;

public class Checkout {
    private final LDClient client;

    public String run(LDContext context) {
        boolean enabled = client.boolVariation("CHECKOUT_V2", context, false);
        return enabled ? "v2" : "v1";
    }
}
