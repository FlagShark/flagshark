package main

import (
	ld "github.com/launchdarkly/go-server-sdk/v7"
)

func multi() {
	enabled, _ := client.BoolVariation(
		"GO_MULTI_LINE",
		ldcontext.New("user"),
		false,
	)
	_ = enabled
}
