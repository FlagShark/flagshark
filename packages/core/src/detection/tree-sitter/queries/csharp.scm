; Method call on a receiver: client.BoolVariation("flag", ...)
(invocation_expression
  function: (member_access_expression
    name: (identifier) @method)
  arguments: (argument_list) @args) @call

; Bare function call: BoolVariation("flag", ...)
(invocation_expression
  function: (identifier) @method
  arguments: (argument_list) @args) @call
