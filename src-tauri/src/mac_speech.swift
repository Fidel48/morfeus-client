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

func transcribe(requiresOnDevice: Bool) -> (String, Bool) {
    let request = SFSpeechURLRecognitionRequest(url: fileURL)
    request.taskHint = .dictation
    request.shouldReportPartialResults = false
    if #available(macOS 10.15, *) {
        request.requiresOnDeviceRecognition = requiresOnDevice
    }

    var finished = false
    var recognizedText = ""
    var hadError = false

    let task = recognizer.recognitionTask(with: request) { result, error in
        if let result = result {
            recognizedText = result.bestTranscription.formattedString
            if result.isFinal {
                finished = true
            }
        }
        if let _ = error {
            hadError = true
            finished = true
        }
    }

    let timeout = Date().addingTimeInterval(8.0)
    while !finished && Date() < timeout {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.04))
    }

    if !finished {
        task.finish()
    }

    return (recognizedText.trimmingCharacters(in: .whitespacesAndNewlines), hadError)
}

// Prefer lightning-fast on-device Neural Engine recognition if supported by macOS
var (text, error) = (recognizer.supportsOnDeviceRecognition) ? transcribe(requiresOnDevice: true) : ("", true)

// Fallback to network speech recognition if on-device model was missing or returned empty
if error || text.isEmpty {
    let (netText, _) = transcribe(requiresOnDevice: false)
    if !netText.isEmpty {
        text = netText
    }
}

print(text)
