// Nearby listeners, over Multipeer Connectivity.
//
// The point is the car: the people beside you are not on your wifi, may not
// be in your friends list, and there is no router in the story at all.
// MultipeerConnectivity meshes Bluetooth LE with peer-to-peer Wi-Fi, so two
// phones on separate cellular connections still find each other across a
// back seat. Same-network detection cannot do that; a shared code can, and
// this is the same thing without anyone reading six characters aloud.
//
// What is broadcast, and when:
//   - NOTHING until the listener switches it on. Discovery is a deliberate
//     act ("I want to jam with whoever is here"), not a background state, so
//     there is no silent beacon following anybody around.
//   - While on: a handle to show on the other phone, and - if hosting - the
//     jam's own code. That code is already the invitation (see jams.rs), so
//     finding a peer IS the invitation arriving, and joining is the ordinary
//     join path with nothing new to trust.
//
// Foreground only, deliberately: iOS starves background BLE scanning, and a
// beacon that outlives the screen is exactly the thing a listener did not
// agree to.

import Foundation
import MultipeerConnectivity

// The Rust side hands us C strings and takes JSON back - the same dumb seam
// carplay.m uses, for the same reason: the two halves tick at different
// rates and neither should wait on the other.
@_cdecl("afm_nearby_start")
public func afmNearbyStart(_ handle: UnsafePointer<CChar>?, _ code: UnsafePointer<CChar>?) {
    let name = handle.map { String(cString: $0) } ?? ""
    let jam = code.map { String(cString: $0) } ?? ""
    AFMNearby.shared.start(handle: name, jamCode: jam.isEmpty ? nil : jam)
}

@_cdecl("afm_nearby_stop")
public func afmNearbyStop() {
    AFMNearby.shared.stop()
}

/// The peers seen right now, as JSON: `[{"handle":"kayla","code":"ab12cd"}]`.
/// Polled rather than pushed, so a webview that was backgrounded cannot miss
/// an edge and sit on a stale list forever.
@_cdecl("afm_nearby_peers")
public func afmNearbyPeers() -> UnsafeMutablePointer<CChar>? {
    strdup(AFMNearby.shared.peersJSON())
}

final class AFMNearby: NSObject {
    static let shared = AFMNearby()

    // Bonjour service types are capped at 15 characters and must be declared
    // in Info.plist (NSBonjourServices) or iOS 14+ refuses to browse at all.
    private static let service = "attackfm-jam"

    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var peerID: MCPeerID?
    /// peer display name -> what they advertised about themselves.
    private var seen: [String: [String: String]] = [:]
    private let lock = NSLock()

    func start(handle: String, jamCode: String?) {
        stop()
        // The device name is not ours to broadcast: the peer id carries a
        // display name, so it gets the handle the listener already publishes
        // to friends rather than "Matt's iPhone".
        let id = MCPeerID(displayName: handle.isEmpty ? "listener" : handle)
        peerID = id

        var info: [String: String] = ["handle": handle]
        if let jamCode { info["code"] = jamCode }

        let ad = MCNearbyServiceAdvertiser(peer: id, discoveryInfo: info, serviceType: Self.service)
        ad.delegate = self
        ad.startAdvertisingPeer()
        advertiser = ad

        let br = MCNearbyServiceBrowser(peer: id, serviceType: Self.service)
        br.delegate = self
        br.startBrowsingForPeers()
        browser = br
    }

    func stop() {
        advertiser?.stopAdvertisingPeer()
        browser?.stopBrowsingForPeers()
        advertiser = nil
        browser = nil
        lock.lock()
        seen.removeAll()
        lock.unlock()
    }

    func peersJSON() -> String {
        lock.lock()
        let rows = seen.map { name, info -> [String: String] in
            var row = info
            row["handle"] = info["handle"] ?? name
            return row
        }
        lock.unlock()
        guard let data = try? JSONSerialization.data(withJSONObject: rows),
              let text = String(data: data, encoding: .utf8)
        else { return "[]" }
        return text
    }
}

extension AFMNearby: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        lock.lock()
        seen[peerID.displayName] = info ?? ["handle": peerID.displayName]
        lock.unlock()
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        lock.lock()
        seen.removeValue(forKey: peerID.displayName)
        lock.unlock()
    }

    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        // Local network permission refused, or no transport available. The
        // list simply stays empty; the code path (Friends -> join with a
        // code) is the fallback and needs none of this.
    }
}

extension AFMNearby: MCNearbyServiceAdvertiserDelegate {
    // No sessions are ever formed: this is discovery only. The audio and the
    // queue travel through the hub exactly as they do for a code join, so
    // there is no peer-to-peer channel to secure, and an invitation that
    // arrives here is declined rather than silently accepted.
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        invitationHandler(false, nil)
    }

    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        // Same as browsing: silence rather than noise, the code path stands.
    }
}

/// Hand back what `afm_nearby_peers` strdup'd. Freeing on the side that
/// allocated keeps one allocator in the story rather than two.
@_cdecl("afm_nearby_free")
public func afmNearbyFree(_ ptr: UnsafeMutablePointer<CChar>?) {
    free(ptr)
}
