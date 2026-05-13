require 'launchdarkly-server-sdk'

class Checkout
  def initialize(client)
    @client = client
  end

  def run(context)
    enabled = @client.variation("CHECKOUT_V2", context, false)
    if enabled
      return "v2"
    end
    "v1"
  end
end
