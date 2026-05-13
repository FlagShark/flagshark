#import <LaunchDarkly/LDClient.h>

@implementation Checkout
- (NSString *)run {
    BOOL enabled = [[LDClient get] boolVariation:@"CHECKOUT_V2" defaultValue:NO];
    if (enabled) {
        return @"v2";
    }
    return @"v1";
}
@end
