// Captura todo o audio do sistema EXCETO o da arvore de processos indicada
// (o proprio Tela), usando o process loopback do WASAPI (Windows 10 20348+).
// Uso: tela-loopback.exe <pid>
// Saida: PCM 16-bit, 48 kHz, estereo intercalado no stdout.
// Escreve "ready" no stderr quando a captura comeca. Encerra quando o stdin fecha.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <io.h>
#include <fcntl.h>

using namespace Microsoft::WRL;

class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activateHr = E_FAIL;
    ComPtr<IUnknown> unk;
    result = op->GetActivateResult(&activateHr, &unk);
    if (SUCCEEDED(result)) result = activateHr;
    if (SUCCEEDED(result)) result = unk.As(&client);
    SetEvent(done);
    return S_OK;
  }
};

static int fail(const char* what, HRESULT hr) {
  fprintf(stderr, "%s failed: 0x%08lx\n", what, static_cast<unsigned long>(hr));
  return 1;
}

static DWORD WINAPI watchStdin(LPVOID) {
  char buf[64];
  DWORD read;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  while (ReadFile(in, buf, sizeof(buf), &read, nullptr) && read > 0) {}
  ExitProcess(0);
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    fprintf(stderr, "uso: tela-loopback.exe <pid>\n");
    return 2;
  }
  DWORD pid = wcstoul(argv[1], nullptr, 10);
  _setmode(_fileno(stdout), _O_BINARY);
  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("CoInitializeEx", hr);

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT prop = {};
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(params);
  prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &prop,
                                   handler.Get(), &op);
  if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync", hr);
  WaitForSingleObject(handler->done, INFINITE);
  if (FAILED(handler->result)) return fail("activation", handler->result);
  IAudioClient* client = handler->client.Get();

  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          200000, 0, &fmt, nullptr);
  if (FAILED(hr)) return fail("Initialize", hr);

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) return fail("SetEventHandle", hr);

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) return fail("GetService", hr);

  hr = client->Start();
  if (FAILED(hr)) return fail("Start", hr);
  fprintf(stderr, "ready\n");
  fflush(stderr);

  std::vector<BYTE> silence;
  for (;;) {
    if (WaitForSingleObject(ready, 1000) != WAIT_OBJECT_0) continue;
    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) return fail("GetBuffer", hr);
      size_t bytes = static_cast<size_t>(frames) * fmt.nBlockAlign;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(bytes, 0);
        data = silence.data();
      }
      bool ok = fwrite(data, 1, bytes, stdout) == bytes && fflush(stdout) == 0;
      capture->ReleaseBuffer(frames);
      if (!ok) return 0;
    }
  }
}
