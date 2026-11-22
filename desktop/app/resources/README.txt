Files in this folder are bundled with the desktop app.

htdemucs.onnx (optional, ~160 MB) is the AI model used by Separate Audio,
Acapella and Karaoke. It is not kept in git. Make it with

    python desktop/tools/export_demucs_onnx.py desktop/app/resources/htdemucs.onnx --fp16

(the GitHub Actions workflow does this automatically). Without it the app
still works and asks for the model file the first time it is needed.
