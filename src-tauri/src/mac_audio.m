#import <AVFoundation/AVFoundation.h>

// Returns: 3 = Authorized, 2 = Denied, 1 = Restricted, 0 = NotDetermined
int check_and_request_mic_permission(void) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status == AVAuthorizationStatusNotDetermined) {
        dispatch_semaphore_t sema = dispatch_semaphore_create(0);
        __block BOOL isGranted = NO;
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
            isGranted = granted;
            dispatch_semaphore_signal(sema);
        }];
        // Wait up to 30 seconds for the user to respond to the macOS permission dialog
        dispatch_semaphore_wait(sema, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        return isGranted ? 3 : 2;
    }
    return (int)status;
}
