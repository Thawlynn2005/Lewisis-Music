Files in this folder are bundled with the desktop app. Neither of the two
below is kept in git; the GitHub Actions workflow adds both automatically.

htdemucs.onnx (~160 MB) is the AI model used by Separate Audio, Acapella and
Karaoke. Make it with

    python desktop/tools/export_demucs_onnx.py desktop/app/resources/htdemucs.onnx --fp16

libonnxruntime.so / onnxruntime.dll / libonnxruntime.dylib is Microsoft's
ONNX Runtime 1.31, which runs the model. Get the one for this computer with

    python desktop/tools/fetch_onnxruntime.py

Without the model the app still works and asks for the model file the first
time it is needed; without ONNX Runtime, AI separation is unavailable.
