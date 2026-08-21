// The AirPlay route picker, summoned from the page.
//
// There is no API that lists routes or moves audio to one - Apple keeps route
// choice inside its own sheet, deliberately - so "AirPlay support" for an app
// means exactly one thing: presenting that sheet from somewhere sensible
// instead of making the listener leave for Control Centre. AVRoutePickerView
// is that sheet's only door, and it is a BUTTON, not a presentable controller:
// the accepted way to open it programmatically is to press its own button for
// it.
//
// The picker is added invisibly, pressed, and removed after the sheet has had
// time to stand up. Removing it immediately would tear down the presentation
// mid-flight; two seconds is comfortably past the animation and the view is
// invisible the whole time either way.

import AVKit
import UIKit

@_cdecl("afm_airplay_show")
public func afmAirplayShow() {
    DispatchQueue.main.async {
        guard
            let window = UIApplication.shared.connectedScenes
                .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
                .first,
            let host = window.rootViewController?.view
        else { return }
        let picker = AVRoutePickerView(frame: .zero)
        picker.isHidden = true
        host.addSubview(picker)
        for sub in picker.subviews {
            if let button = sub as? UIButton {
                button.sendActions(for: .touchUpInside)
                break
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            picker.removeFromSuperview()
        }
    }
}
