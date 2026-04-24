import Cocoa
import Vision

struct OCRLine {
    let text: String
    let box: CGRect
}

func sortedOCRLines(from results: [VNRecognizedTextObservation]) -> [OCRLine] {
    let lines = results.compactMap { observation -> OCRLine? in
        guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            return nil
        }
        return OCRLine(text: text, box: observation.boundingBox)
    }

    // Vision coordinates are normalized with origin at bottom-left.
    // Read order for Japanese UI text is usually top-to-bottom, left-to-right.
    return lines.sorted { a, b in
        let aTop = a.box.maxY
        let bTop = b.box.maxY
        if abs(aTop - bTop) > 0.01 {
            return aTop > bTop
        }
        return a.box.minX < b.box.minX
    }
}

func mergeWrappedLines(_ lines: [OCRLine]) -> [String] {
    guard !lines.isEmpty else { return [] }

    var paragraphs: [String] = []
    var prev = lines[0]
    var currentText = prev.text

    for line in lines.dropFirst() {
        let verticalGap = max(0, prev.box.minY - line.box.maxY)
        let avgHeight = max(0.0001, (prev.box.height + line.box.height) / 2.0)
        let leftAligned = abs(prev.box.minX - line.box.minX) < 0.06
        let sameBlock = verticalGap < (avgHeight * 0.65) && leftAligned

        if sameBlock {
            currentText += line.text
        } else {
            paragraphs.append(currentText)
            currentText = line.text
        }
        prev = line
    }

    paragraphs.append(currentText)
    return paragraphs
}

func splitParagraphIntoSentences(_ paragraph: String) -> [String] {
    let trimmed = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return [] }

    // Split on Japanese sentence-ending punctuation while keeping delimiter.
    let pattern = #"[^。！？!?]+[。！？!?]*"#
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
        return [trimmed]
    }

    let ns = trimmed as NSString
    let range = NSRange(location: 0, length: ns.length)
    let matches = regex.matches(in: trimmed, options: [], range: range)
    let sentences = matches
        .map { ns.substring(with: $0.range).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }

    return sentences.isEmpty ? [trimmed] : sentences
}

let args = CommandLine.arguments
guard args.count > 1 else {
    print("Usage: mac-ocr <image-path>")
    exit(1)
}

let imagePath = args[1]
guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("Error: Failed to load image\n", stderr)
    exit(1)
}

let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
let request = VNRecognizeTextRequest { (request, error) in
    if let error = error {
        fputs("Error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    
    guard let results = request.results as? [VNRecognizedTextObservation] else { return }
    
    let lines = sortedOCRLines(from: results)
    let paragraphs = mergeWrappedLines(lines)
    let units = paragraphs.flatMap(splitParagraphIntoSentences)
    let recognizedText = units.joined(separator: "\n")
    
    print(recognizedText)
}

// Bias toward Japanese for short UI snippets and labels.
request.recognitionLanguages = ["ja-JP"] // Force Japanese only
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false   // Stop hallucinating numbers
request.minimumTextHeight = 0.01

do {
    try requestHandler.perform([request])
} catch {
    fputs("Error: \(error)\n", stderr)
    exit(1)
}