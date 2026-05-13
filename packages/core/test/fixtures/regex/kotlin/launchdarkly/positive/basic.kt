import com.launchdarkly.sdk.server.LDClient

class Checkout(private val client: LDClient) {
    fun run(context: LDContext): String {
        val enabled = client.boolVariation("CHECKOUT_V2", context, false)
        if (enabled) {
            return "v2"
        }
        return "v1"
    }
}
