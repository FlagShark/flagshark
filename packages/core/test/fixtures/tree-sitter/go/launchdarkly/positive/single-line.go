package main

import (
	ld "github.com/launchdarkly/go-server-sdk/v7"
)

func main() {
	client, _ := ld.MakeClient("sdk-key", 5)
	defer client.Close()

	enabled, _ := client.BoolVariation("GO_CHECKOUT_V2", ldcontext.New("user"), false)
	if enabled {
		println("v2")
	}
}
