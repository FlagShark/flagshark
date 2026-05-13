<?php
use LaunchDarkly\LDClient;

class Checkout {
    private $client;

    public function __construct($client) {
        $this->client = $client;
    }

    public function run($context) {
        $enabled = $this->client->variation("CHECKOUT_V2", $context, false);
        if ($enabled) {
            return "v2";
        }
        return "v1";
    }
}
