import Foundation
import Testing
@testable import CableCore

@Test func serverAddressAcceptsWhatPeopleType() {
    #expect(ServerAddress.parse("192.168.1.42")?.absoluteString == "http://192.168.1.42:1982/")
    #expect(ServerAddress.parse(" 192.168.1.42:8080 ")?.absoluteString == "http://192.168.1.42:8080/")
    #expect(ServerAddress.parse("media.local")?.absoluteString == "http://media.local:1982/")
    #expect(ServerAddress.parse("http://192.168.1.42:1982/config")?.absoluteString == "http://192.168.1.42:1982/")
    #expect(ServerAddress.parse("https://tv.example.com")?.absoluteString == "https://tv.example.com/")
    #expect(ServerAddress.parse("") == nil)
    #expect(ServerAddress.parse("ftp://x") == nil)
}

@Test func mediaURLsResolveAgainstTheServer() {
    let c = StationClient(baseURL: URL(string: "http://10.0.0.5:1982/")!)
    #expect(c.mediaURL("channels/retro-tv/01%20Duck%20and%20Cover.mp4").absoluteString ==
            "http://10.0.0.5:1982/channels/retro-tv/01%20Duck%20and%20Cover.mp4")
}
