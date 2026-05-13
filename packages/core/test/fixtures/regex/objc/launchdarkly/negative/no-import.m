@implementation Plain
- (BOOL)isEnabled {
    return [[self client] boolVariation:@"not-detected-without-import" defaultValue:NO];
}
@end
