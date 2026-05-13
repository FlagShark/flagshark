# Objective-C regex corpus — known limitation

The regex-based flag detector at `packages/core/src/detection/helpers.ts`
(`buildSingleMethodPattern`) matches function-call syntax `method(...)` only.
Objective-C uses bracket-call syntax `[obj method:arg]` for all method
invocations, which has no parenthesis after the method name. As a result,
**flag keys cannot currently be extracted from idiomatic Objective-C source**.

That limitation means a positive fixture (idiomatic Objective-C LaunchDarkly
call with a real flag key) would silently fail detection. The corpus here
only tests the negative path — confirming that a file lacking the
`LaunchDarkly` import produces zero detections.

Adding positive Objective-C detection requires extending
`detectFlagsWithRegex` to recognise bracket-call syntax. That work is
out of scope for the coverage initiative and tracked as a backlog item.
