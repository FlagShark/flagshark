; Method call on an object: $client->variation("flag", ...)
(member_call_expression
  name: (name) @method
  arguments: (arguments) @args) @call

; Bare function call: variation("flag", ...)
(function_call_expression
  function: (name) @method
  arguments: (arguments) @args) @call

; Static call: Statsig::checkGate(..., "flag"), Feature::active("flag")
(scoped_call_expression
  name: (name) @method
  arguments: (arguments) @args) @call
