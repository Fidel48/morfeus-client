import Foundation
import Speech

guard CommandLine.arguments.count > 1 else {
    fputs("ERROR: Missing audio file path\n", stderr)
    exit(1)
}

let audioPath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: audioPath)

guard FileManager.default.fileExists(atPath: audioPath) else {
    fputs("ERROR: Audio file not found at: \(audioPath)\n", stderr)
    exit(1)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
    fputs("ERROR: Apple SFSpeechRecognizer unavailable on this Mac\n", stderr)
    exit(1)
}

let request = SFSpeechURLRecognitionRequest(url: fileURL)
if #available(macOS 10.15, *) {
    request.requiresOnDeviceRecognition = false
}

var finished = false
var recognizedText = ""

recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        recognizedText = result.bestTranscription.formattedString
        if result.isFinal {
            finished = true
        }
    } else if let error = error {
        fputs("ERROR: \(error.localizedDescription)\n", stderr)
        finished = true
    }
}

// Pump the macOS event loop to allow Apple SFSpeechRecognizer to transcribe audio natively
let timeout = Date().addingTimeInterval(6.0)
while !finished && Date() < timeout {
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
}

print(recognizedText)
