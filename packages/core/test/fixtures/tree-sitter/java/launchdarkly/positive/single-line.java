import com.launchdarkly.sdk.server.LDClient;
import com.launchdarkly.sdk.LDContext;

public class Example {
    public void run(LDClient client, LDContext ctx) {
        boolean enabled = client.boolVariation("JAVA_CHECKOUT_V2", ctx, false);
        if (enabled) {
            System.out.println("v2");
        }
    }
}
