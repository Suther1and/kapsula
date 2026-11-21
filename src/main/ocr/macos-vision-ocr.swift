import Foundation
import Vision

struct OcrOutput: Encodable {
  let text: String
  let lines: [String]
}

func emit(_ output: OcrOutput) {
  let encoder = JSONEncoder()
  if let data = try? encoder.encode(output) {
    try? FileHandle.standardOutput.write(contentsOf: data)
  } else {
    try? FileHandle.standardOutput.write(contentsOf: Data("{\"text\":\"\",\"lines\":[]}".utf8))
  }
}

guard CommandLine.arguments.count >= 2 else {
  emit(OcrOutput(text: "", lines: []))
  exit(0)
}

let imagePath = CommandLine.arguments[1]
let imageUrl = URL(fileURLWithPath: imagePath)

guard FileManager.default.fileExists(atPath: imagePath) else {
  emit(OcrOutput(text: "", lines: []))
  exit(0)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["ru-RU", "en-US"]
if #available(macOS 13.0, *) {
  request.automaticallyDetectsLanguage = true
}

// URL initializer lets Vision honor EXIF orientation automatically (portrait iPhone/HEIC/JPEG photos)
let handler = VNImageRequestHandler(url: imageUrl, options: [:])
do {
  try handler.perform([request])
  let observations = (request.results ?? []).sorted { a, b in
    let boxA = a.boundingBox
    let boxB = b.boundingBox
    let lineTolerance = 0.5 * min(boxA.height, boxB.height)
    if abs(boxA.midY - boxB.midY) <= lineTolerance {
      return boxA.minX < boxB.minX
    }
    return boxA.midY > boxB.midY
  }

  var lines: [String] = []
  lines.reserveCapacity(observations.count)
  for observation in observations {
    if let top = observation.topCandidates(1).first {
      let cleaned = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
      if !cleaned.isEmpty {
        lines.append(cleaned)
      }
    }
  }
  emit(OcrOutput(text: lines.joined(separator: "\n"), lines: lines))
} catch {
  if let errData = "macos-vision-ocr error: \(error.localizedDescription)\n".data(using: .utf8) {
    try? FileHandle.standardError.write(contentsOf: errData)
  }
  emit(OcrOutput(text: "", lines: []))
}
