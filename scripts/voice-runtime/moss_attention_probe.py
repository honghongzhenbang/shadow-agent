"""Test-only backend control and bounded operator tracing; never a production policy."""
from contextlib import contextmanager, nullcontext


def backend_context(torch, backend):
    if backend == "auto":
        return nullcontext()
    names = {"flash": "FLASH_ATTENTION", "efficient": "EFFICIENT_ATTENTION",
             "math": "MATH", "cudnn": "CUDNN_ATTENTION"}
    if backend not in names:
        raise ValueError("Unknown SDPA backend: " + backend)
    attention = torch.nn.attention
    return attention.sdpa_kernel([getattr(attention.SDPBackend, names[backend])])


def attention_signature(q, k, mask, causal):
    # Decode lengths grow every token. Trace one example per structural call kind.
    return (str(q.dtype), q.shape[-3], k.shape[-3], q.shape[-1],
            "decode" if q.shape[-2] == 1 else "prefill", mask is not None, bool(causal))


@contextmanager
def trace_attention(torch, enabled, records):
    if not enabled:
        yield
        return
    functional = torch.nn.functional
    original = functional.scaled_dot_product_attention
    seen = set()

    def traced(q, k, v, *args, **kwargs):
        mask = args[0] if args else kwargs.get("attn_mask")
        causal = args[2] if len(args) > 2 else kwargs.get("is_causal", False)
        signature = attention_signature(q, k, mask, causal)
        if signature in seen:
            return original(q, k, v, *args, **kwargs)
        seen.add(signature)
        row = {"signature": signature, "queryShape": list(q.shape), "keyShape": list(k.shape)}
        records.append(row)
        with torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU],
                                    record_shapes=False, profile_memory=False) as profile:
            result = original(q, k, v, *args, **kwargs)
            torch.cuda.synchronize()
        row["operators"] = [{"name": event.key, "count": event.count}
                            for event in profile.key_averages()
                            if "attention" in event.key or "softmax" in event.key]
        return result

    functional.scaled_dot_product_attention = traced
    try:
        yield
    finally:
        functional.scaled_dot_product_attention = original


def process_memory(process):
    memory = process.memory_info()
    return {"rssBytes": memory.rss, "privateBytes": getattr(memory, "private", None),
            "pageFaults": getattr(memory, "num_page_faults", None)}
