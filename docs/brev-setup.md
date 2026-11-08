# Nemotron on NVIDIA Brev

How to start, stop and reconnect to the GPU box that serves our fast Nemotron model.

| | |
|---|---|
| Model | `nvidia/NVIDIA-Nemotron-Nano-9B-v2` (BF16, from Hugging Face) |
| Server | vLLM `vllm/vllm-openai:v0.10.1`, OpenAI-compatible (`/v1/chat/completions`) |
| Instance | `hope-nemotron`, type `hyperstack_A6000` (1x RTX A6000, 48 GB) |
| Cost | **about $0.60/hr while it exists** (~$14.40/day) |
| Endpoint (from your laptop) | `http://localhost:8000/v1` through `brev port-forward` |

> **This instance type cannot be stopped.** `brev stop` is not supported on `hyperstack_A6000`.
> The only way to stop paying is `brev delete hope-nemotron`. Delete it when the hackathon
> is over (or whenever nobody needs it for a few hours). Starting again takes ~15 minutes.

## One-time setup (each teammate)

1. **Windows:** install WSL Ubuntu (PowerShell as admin: `wsl --install -d Ubuntu-22.04`),
   then do everything below inside the Ubuntu terminal. macOS: `brew install brevdev/homebrew-brev/brev`.
2. Install the Brev CLI (Linux / WSL):
   ```bash
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/brevdev/brev-cli/main/bin/install-latest.sh)"
   brev --version
   ```
3. `brev login` (opens the browser). Ask the org owner to invite you to the Brev org first,
   otherwise you won't see `hope-nemotron`.
4. Copy `agents/.env.example` to `agents/.env`. Get the API key from the instance (step
   "Get the API key" below) and paste it into **your own** `agents/.env` only.
   Never put it in chat, Slack, Discord or a commit.

## Check what's running

```bash
brev ls
```
`hope-nemotron  RUNNING ...` means it exists and is billing.

## Reconnect (instance already running)

1. Open the tunnel and leave this terminal open:
   ```bash
   brev port-forward hope-nemotron --port 8000:8000
   ```
2. In another terminal, from the repo:
   ```bash
   cd agents
   node test-nemotron.js
   ```
   You should see `Reply: OK ...` and a response time.

If the forward fails after the instance was recreated, run `brev refresh` and try again.
If `brev port-forward` misbehaves, plain SSH does the same job:
`ssh -N -L 8000:localhost:8000 hope-nemotron`.

On Windows, run the forward in the WSL Ubuntu terminal and keep that window open; Node on
Windows reaches it at `localhost:8000` through WSL's localhost forwarding.

Expected test output: a reply like `OK, I'm a language model developed by NVIDIA.`
The first call after a restart takes a few seconds; warm calls take ~0.3-0.6 s.

`agents/.env` for this setup:
```
NEMOTRON_BASE_URL=http://localhost:8000/v1
NEMOTRON_API_KEY=<from ~/nemotron.key on the instance>
NEMOTRON_FAST_MODEL=nvidia/NVIDIA-Nemotron-Nano-9B-v2
```

### Get the API key

```bash
brev shell hope-nemotron
cat ~/nemotron.key
exit
```
Copy it into your `agents/.env`. Every teammate uses the same key.

## Check the model server

```bash
brev shell hope-nemotron
docker ps                       # "nemotron  Up ..."
docker logs --tail 50 nemotron  # look for "Application startup complete"
nvidia-smi                      # ~43 of 48 GB used is normal: vLLM reserves memory up front
```
The container has `--restart unless-stopped`, so it comes back if the box reboots.
Restart it by hand with `docker restart nemotron` (model is cached, ~2 minutes).

## Stop (stop paying)

```bash
brev delete hope-nemotron
brev ls    # confirm it's gone
```
This erases the instance, including the downloaded model and the API key.
The next start creates a new key, so everyone updates their `agents/.env`.

## Start from scratch

Costs money from the moment `brev create` runs.

1. Check live prices (free):
   ```bash
   brev search --min-vram 24 --sort price
   ```
2. Create the instance (~6 minutes):
   ```bash
   brev create hope-nemotron --type hyperstack_A6000 --timeout 900
   ```
   If that type has no capacity, a stoppable fallback is `g6.xlarge` (AWS L4 24 GB, ~$0.97/hr,
   supports `brev stop` / `brev start`). On a 24 GB card change `--max-model-len` below to `32768`.
3. Open a shell and start the model server (first start downloads ~18 GB, 5-10 minutes):
   ```bash
   brev shell hope-nemotron
   ```
   Then on the instance:
   ```bash
   umask 077
   [ -s ~/nemotron.key ] || openssl rand -hex 32 > ~/nemotron.key
   mkdir -p ~/.cache/huggingface
   docker run -d --name nemotron --restart unless-stopped --gpus all --ipc=host \
     -p 127.0.0.1:8000:8000 \
     -v ~/.cache/huggingface:/root/.cache/huggingface \
     vllm/vllm-openai:v0.10.1 \
     --model nvidia/NVIDIA-Nemotron-Nano-9B-v2 --trust-remote-code \
     --mamba_ssm_cache_dtype float32 --max-num-seqs 64 --max-model-len 131072 \
     --api-key "$(cat ~/nemotron.key)"
   docker logs -f nemotron   # wait for "Application startup complete", then Ctrl+C
   ```
4. Follow **Reconnect** above.

Notes:
- `--mamba_ssm_cache_dtype float32` is required by NVIDIA for accurate output. Don't drop it.
- The port is bound to `127.0.0.1` on the instance, so it is not open to the internet.
  Access is only through `brev port-forward` (SSH). Brev's console "tunnels" need a browser
  login, so they don't work for API calls.
- Reasoning: Nemotron Nano v2 thinks by default. Put `/no_think` in the system prompt for
  fast triage calls, `/think` when you want the reasoning trace.
- No Hugging Face token is needed; the model is not gated.
