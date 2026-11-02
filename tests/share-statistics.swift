import Foundation
@main struct Tests {
 static func main() throws {
  for text in ["https://youtu.be/BoPiM57aJSc?t=9", "Video https://www.youtube.com/watch?v=BoPiM57aJSc&t=9", "https://m.youtube.com/shorts/BoPiM57aJSc", "https://youtube.com/live/BoPiM57aJSc"] { assert(SharedVideo.id(in: text) == "BoPiM57aJSc") }
  for text in ["https://youtube.com.evil.org/watch?v=BoPiM57aJSc", "https://youtube.com/watch?v=bad", "https://youtube.com/watch?v=BoPiM57aJSc&v=AAAAAAAAAAA", "https://youtu.be/BoPiM57aJSc https://youtu.be/AAAAAAAAAAA", "file:///watch?v=BoPiM57aJSc"] { assert(SharedVideo.id(in: text) == nil) }
  let decoder = JSONDecoder()
  let zero = try decoder.decode(VideoStatistics.self, from: Data("{\"likes\":0,\"dislikes\":0}".utf8)).validated(for: "BoPiM57aJSc")
  assert(zero.dislikes == 0)
  for json in ["{\"likes\":1,\"dislikes\":-1}", "{\"likes\":1,\"dislikes\":1.2}", "{\"likes\":1,\"dislikes\":null}", "{\"id\":\"wrong\",\"likes\":1,\"dislikes\":1}"] {
   do { _ = try decoder.decode(VideoStatistics.self, from: Data(json.utf8)).validated(for: "BoPiM57aJSc"); fatalError("accepted invalid data") } catch {}
  }
  print("14 share parser/response checks passed")
 }
}
