// AttackFM on the car screen.
//
// CarPlay cannot show a webview - the car UI is built from CPTemplate objects
// or it does not exist - so this file is the whole car-facing app: a tab bar
// of Liked / Artists / Songs lists and the system Now Playing screen. The
// audio itself never moves: it keeps playing inside the WKWebView on the
// phone, and this surface is a remote control for it.
//
// The seam runs through four C functions (carplay.h). Rust pushes the library
// and the now-playing state in; taps and transport commands flow out to Rust,
// which forwards them to the webview as Tauri events. Nothing here talks to
// the server and nothing here decodes audio.
//
// Now Playing is fed natively (MPNowPlayingInfoCenter + MPRemoteCommandCenter)
// rather than trusting WKWebView to reflect <audio> state to the system:
// WebKit's reflection breaks subtly when the element plays through a WebAudio
// graph, and CarPlay without a working Now Playing screen is not CarPlay.
//
// HAND-WRITTEN, like project.yml's other marked edits: `tauri ios init`
// regenerates this directory's *project*, not its sources, but a full
// delete-and-reinit loses this file. It is compiled in because project.yml's
// target sources include `Sources`, and xcodegen must be re-run to pick it up.

#import "carplay.h"
#import <CarPlay/CarPlay.h>
#import <MediaPlayer/MediaPlayer.h>
#import <UIKit/UIKit.h>

#pragma mark - Store

@interface AFMCarPlayStore : NSObject
@property(nonatomic, strong) NSArray<NSDictionary *> *tracks;
@property(nonatomic, strong) NSArray<NSNumber *> *likedIds;
@property(nonatomic, strong) CPInterfaceController *interfaceController;
@property(nonatomic, strong) NSCache<NSString *, UIImage *> *artCache;
@property(nonatomic, copy) NSString *nowPlayingArtUrl;
+ (instancetype)shared;
@end

@implementation AFMCarPlayStore

+ (instancetype)shared {
  static AFMCarPlayStore *store;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    store = [AFMCarPlayStore new];
    store.tracks = @[];
    store.likedIds = @[];
    store.artCache = [NSCache new];
    store.artCache.countLimit = 120;
  });
  return store;
}

- (nullable NSDictionary *)trackById:(long long)trackId {
  for (NSDictionary *track in self.tracks) {
    if ([track[@"id"] longLongValue] == trackId) return track;
  }
  return nil;
}

#pragma mark - Artwork

// Fetches a cover and hands back a UIImage on the main queue. The URLs carry
// their own stream token, so no headers are needed. Failures are silent: a
// list without thumbnails is a working list.
- (void)artFor:(NSString *)urlString then:(void (^)(UIImage *_Nullable))then {
  if (urlString.length == 0) {
    then(nil);
    return;
  }
  UIImage *cached = [self.artCache objectForKey:urlString];
  if (cached) {
    then(cached);
    return;
  }
  NSURL *url = [NSURL URLWithString:urlString];
  if (!url) {
    then(nil);
    return;
  }
  [[[NSURLSession sharedSession]
      dataTaskWithURL:url
    completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
      UIImage *image = data ? [UIImage imageWithData:data] : nil;
      if (image) [self.artCache setObject:image forKey:urlString];
      dispatch_async(dispatch_get_main_queue(), ^{
        then(image);
      });
    }] resume];
}

#pragma mark - List building

- (CPListItem *)itemForTrack:(NSDictionary *)track context:(NSString *)context {
  NSString *title = track[@"title"] ?: @"";
  NSString *artist = track[@"artist"] ?: @"";
  CPListItem *item = [[CPListItem alloc] initWithText:title detailText:artist];
  long long trackId = [track[@"id"] longLongValue];
  NSString *artUrl = track[@"artUrl"] ?: @"";

  item.handler = ^(id<CPSelectableListItem> selected, dispatch_block_t completion) {
    afm_carplay_play_track(trackId, context.UTF8String);
    // Selecting a song takes the car screen to Now Playing, the way every
    // audio app on the platform behaves.
    AFMCarPlayStore *store = [AFMCarPlayStore shared];
    if (store.interfaceController) {
      [store.interfaceController pushTemplate:[CPNowPlayingTemplate sharedTemplate]
                                     animated:YES
                                   completion:nil];
    }
    completion();
  };

  // Thumbnails load lazily and update in place; the guard keeps an SDK
  // without settable images (pre-iOS 14 shapes) from crashing rather than
  // merely lacking art.
  if (artUrl.length > 0 && [item respondsToSelector:@selector(setImage:)]) {
    [self artFor:artUrl then:^(UIImage *image) {
      if (image) [item setImage:image];
    }];
  }
  return item;
}

- (NSArray<CPListItem *> *)itemsFor:(NSArray<NSDictionary *> *)tracks
                            context:(NSString *)context
                                cap:(NSUInteger)cap {
  NSMutableArray *items = [NSMutableArray array];
  for (NSDictionary *track in tracks) {
    if (items.count >= cap) break;
    [items addObject:[self itemForTrack:track context:context]];
  }
  return items;
}

- (CPListTemplate *)likedTemplate {
  NSMutableArray<NSDictionary *> *liked = [NSMutableArray array];
  for (NSNumber *likedId in self.likedIds) {
    NSDictionary *track = [self trackById:likedId.longLongValue];
    if (track) [liked addObject:track];
  }
  NSUInteger cap = CPListTemplate.maximumItemCount;
  CPListSection *section = [[CPListSection alloc]
      initWithItems:[self itemsFor:liked context:@"liked" cap:cap]];
  CPListTemplate *template = [[CPListTemplate alloc] initWithTitle:@"Liked"
                                                          sections:@[ section ]];
  template.tabTitle = @"Liked";
  template.tabImage = [UIImage systemImageNamed:@"heart.fill"];
  if ([template respondsToSelector:@selector(setEmptyViewTitleVariants:)]) {
    template.emptyViewTitleVariants = @[ @"No liked songs yet" ];
    template.emptyViewSubtitleVariants =
        @[ @"Tap the heart on a song in AttackFM." ];
  }
  return template;
}

// Artists is a two-level tree: a list of artists, each pushing that artist's
// songs ordered album-first then track number - the same order the webview
// builds the queue in when one is picked, so what plays next in the car is
// what the phone would have played next.
- (CPListTemplate *)artistsTemplate {
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  NSMutableDictionary<NSString *, NSMutableArray<NSDictionary *> *> *byArtist =
      [NSMutableDictionary dictionary];
  for (NSDictionary *track in self.tracks) {
    NSString *artist = track[@"artist"] ?: @"Unknown artist";
    if (!byArtist[artist]) {
      byArtist[artist] = [NSMutableArray array];
      [names addObject:artist];
    }
    [byArtist[artist] addObject:track];
  }
  [names sortUsingSelector:@selector(localizedCaseInsensitiveCompare:)];

  NSMutableArray<CPListItem *> *artistItems = [NSMutableArray array];
  NSUInteger cap = CPListTemplate.maximumItemCount;
  for (NSString *name in names) {
    if (artistItems.count >= cap) break;
    NSMutableArray<NSDictionary *> *songs = byArtist[name];
    [songs sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
      NSComparisonResult byAlbum = [(a[@"album"] ?: @"")
          localizedCaseInsensitiveCompare:(b[@"album"] ?: @"")];
      if (byAlbum != NSOrderedSame) return byAlbum;
      return [(a[@"trackNo"] ?: @0) compare:(b[@"trackNo"] ?: @0)];
    }];
    NSString *detail =
        [NSString stringWithFormat:@"%lu song%s", (unsigned long)songs.count,
                                   songs.count == 1 ? "" : "s"];
    CPListItem *item = [[CPListItem alloc] initWithText:name detailText:detail];
    NSString *context = [@"artist:" stringByAppendingString:name];
    item.handler = ^(id<CPSelectableListItem> selected, dispatch_block_t completion) {
      AFMCarPlayStore *store = [AFMCarPlayStore shared];
      CPListSection *section = [[CPListSection alloc]
          initWithItems:[store itemsFor:songs
                                context:context
                                    cap:CPListTemplate.maximumItemCount]];
      CPListTemplate *songsTemplate =
          [[CPListTemplate alloc] initWithTitle:name sections:@[ section ]];
      if (store.interfaceController) {
        [store.interfaceController pushTemplate:songsTemplate
                                       animated:YES
                                     completion:nil];
      }
      completion();
    };
    [artistItems addObject:item];
  }

  CPListSection *section = [[CPListSection alloc] initWithItems:artistItems];
  CPListTemplate *template = [[CPListTemplate alloc] initWithTitle:@"Artists"
                                                          sections:@[ section ]];
  template.tabTitle = @"Artists";
  template.tabImage = [UIImage systemImageNamed:@"music.mic"];
  return template;
}

- (CPListTemplate *)songsTemplate {
  NSArray<NSDictionary *> *sorted = [self.tracks
      sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [(a[@"title"] ?: @"")
            localizedCaseInsensitiveCompare:(b[@"title"] ?: @"")];
      }];
  NSUInteger cap = CPListTemplate.maximumItemCount;
  CPListSection *section = [[CPListSection alloc]
      initWithItems:[self itemsFor:sorted context:@"songs" cap:cap]];
  CPListTemplate *template = [[CPListTemplate alloc] initWithTitle:@"Songs"
                                                          sections:@[ section ]];
  template.tabTitle = @"Songs";
  template.tabImage = [UIImage systemImageNamed:@"music.note.list"];
  if ([template respondsToSelector:@selector(setEmptyViewTitleVariants:)]) {
    template.emptyViewTitleVariants = @[ @"Nothing synced yet" ];
    template.emptyViewSubtitleVariants =
        @[ @"Open AttackFM on your iPhone and connect to your server." ];
  }
  return template;
}

- (void)rebuildTemplates {
  if (!self.interfaceController) return;
  CPTabBarTemplate *root = [[CPTabBarTemplate alloc] initWithTemplates:@[
    [self likedTemplate], [self artistsTemplate], [self songsTemplate]
  ]];
  [self.interfaceController setRootTemplate:root animated:YES completion:nil];
}

- (void)reloadFromJSONString:(NSString *)json {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) return;
  NSDictionary *parsed = [NSJSONSerialization JSONObjectWithData:data
                                                         options:0
                                                           error:nil];
  if (![parsed isKindOfClass:[NSDictionary class]]) return;
  NSArray *tracks = parsed[@"tracks"];
  NSArray *liked = parsed[@"liked"];
  self.tracks = [tracks isKindOfClass:[NSArray class]] ? tracks : @[];
  self.likedIds = [liked isKindOfClass:[NSArray class]] ? liked : @[];
  [self rebuildTemplates];
}

#pragma mark - Now playing

// The system now-playing state, which CarPlay's Now Playing template renders.
// Elapsed time plus a playback rate is the whole trick: iOS extrapolates the
// clock itself, so this only needs a push when something discontinuous
// happens - a track change, a pause, a seek.
- (void)setNowPlayingFromJSONString:(NSString *)json {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) return;
  NSDictionary *info = [NSJSONSerialization JSONObjectWithData:data
                                                       options:0
                                                         error:nil];
  if (![info isKindOfClass:[NSDictionary class]]) return;

  [AFMCarPlayStore ensureRemoteCommands];

  NSMutableDictionary *center = [NSMutableDictionary dictionary];
  center[MPMediaItemPropertyTitle] = info[@"title"] ?: @"";
  center[MPMediaItemPropertyArtist] = info[@"artist"] ?: @"";
  center[MPMediaItemPropertyAlbumTitle] = info[@"album"] ?: @"";
  center[MPNowPlayingInfoPropertyMediaType] = @(MPNowPlayingInfoMediaTypeAudio);
  NSNumber *duration = info[@"duration"];
  if ([duration isKindOfClass:[NSNumber class]] && duration.doubleValue > 0) {
    center[MPMediaItemPropertyPlaybackDuration] = duration;
  }
  NSNumber *position = info[@"position"];
  if ([position isKindOfClass:[NSNumber class]]) {
    center[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position;
  }
  BOOL playing = [info[@"playing"] boolValue];
  center[MPNowPlayingInfoPropertyPlaybackRate] = playing ? @1.0 : @0.0;

  MPNowPlayingInfoCenter.defaultCenter.nowPlayingInfo = center;

  // Artwork arrives late and re-publishes; the token check keeps a slow cover
  // from stamping itself onto whatever track came after it.
  NSString *artUrl = info[@"artUrl"] ?: @"";
  self.nowPlayingArtUrl = artUrl;
  if (artUrl.length > 0) {
    [self artFor:artUrl then:^(UIImage *image) {
      AFMCarPlayStore *store = [AFMCarPlayStore shared];
      if (!image || ![store.nowPlayingArtUrl isEqualToString:artUrl]) return;
      MPMediaItemArtwork *artwork = [[MPMediaItemArtwork alloc]
          initWithBoundsSize:image.size
              requestHandler:^UIImage *(CGSize size) {
                return image;
              }];
      NSMutableDictionary *withArt = [(MPNowPlayingInfoCenter.defaultCenter
                                           .nowPlayingInfo ?: @{}) mutableCopy];
      withArt[MPMediaItemPropertyArtwork] = artwork;
      MPNowPlayingInfoCenter.defaultCenter.nowPlayingInfo = withArt;
    }];
  }
}

// The transport commands the car and the lock screen send. Registered once,
// lazily, at the first now-playing push - an app that never plays never
// claims the controls.
+ (void)ensureRemoteCommands {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    MPRemoteCommandCenter *commands = [MPRemoteCommandCenter sharedCommandCenter];
    [commands.playCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
      afm_carplay_remote("play");
      return MPRemoteCommandHandlerStatusSuccess;
    }];
    [commands.pauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
      afm_carplay_remote("pause");
      return MPRemoteCommandHandlerStatusSuccess;
    }];
    [commands.togglePlayPauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
      afm_carplay_remote("toggle");
      return MPRemoteCommandHandlerStatusSuccess;
    }];
    [commands.nextTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
      afm_carplay_remote("next");
      return MPRemoteCommandHandlerStatusSuccess;
    }];
    [commands.previousTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
      afm_carplay_remote("previous");
      return MPRemoteCommandHandlerStatusSuccess;
    }];
    [commands.changePlaybackPositionCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
      MPChangePlaybackPositionCommandEvent *seek =
          (MPChangePlaybackPositionCommandEvent *)event;
      char buffer[48];
      snprintf(buffer, sizeof buffer, "seek:%.3f", seek.positionTime);
      afm_carplay_remote(buffer);
      return MPRemoteCommandHandlerStatusSuccess;
    }];
  });
}

@end

#pragma mark - Idle timer

// The Spotify move: while the full-screen player is up, the phone must not
// lock - the webview dims itself instead. Main-thread hop because the idle
// timer is UIKit state; safe to call from any thread, idempotent both ways.
void afm_set_idle_timer_disabled(int disabled) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIApplication sharedApplication].idleTimerDisabled = disabled ? YES : NO;
  });
}

#pragma mark - Scene delegate

// Named in Info.plist under CPTemplateApplicationSceneSessionRoleApplication.
// UIKit instantiates this when a car connects; the phone's own scene (tao's)
// is untouched. Both exist because UIApplicationSupportsMultipleScenes is
// true - which it already had to be for tao.
@interface AFMCarPlaySceneDelegate
    : UIResponder <CPTemplateApplicationSceneDelegate>
@end

@implementation AFMCarPlaySceneDelegate

- (void)templateApplicationScene:(CPTemplateApplicationScene *)scene
    didConnectInterfaceController:(CPInterfaceController *)controller {
  AFMCarPlayStore *store = [AFMCarPlayStore shared];
  store.interfaceController = controller;
  [store rebuildTemplates];
}

- (void)templateApplicationScene:(CPTemplateApplicationScene *)scene
    didDisconnectInterfaceController:(CPInterfaceController *)controller {
  AFMCarPlayStore *store = [AFMCarPlayStore shared];
  if (store.interfaceController == controller) {
    store.interfaceController = nil;
  }
}

@end

#pragma mark - C surface (Rust calls these)

void afm_carplay_set_library(const char *json) {
  if (!json) return;
  NSString *string = [NSString stringWithUTF8String:json];
  if (!string) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    [[AFMCarPlayStore shared] reloadFromJSONString:string];
  });
}

void afm_carplay_set_now_playing(const char *json) {
  if (!json) return;
  NSString *string = [NSString stringWithUTF8String:json];
  if (!string) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    [[AFMCarPlayStore shared] setNowPlayingFromJSONString:string];
  });
}
