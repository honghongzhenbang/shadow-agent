"""Local MOSS runtime adaptations; model weights and decoding context stay unchanged."""


def install_encoder_microbatch(model, batch_size=1):
    """Bound independent Whisper chunk batches, not the joint transcript context."""
    import torch
    from transformers.modeling_outputs import BaseModelOutput

    if not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("Encoder batch size must be positive")

    class ChunkedEncoder(torch.nn.Module):
        def __init__(self, encoder):
            super().__init__()
            self.encoder = encoder

        def forward(self, features, *args, **kwargs):
            if features.shape[0] <= batch_size:
                return self.encoder(features, *args, **kwargs)
            if args or kwargs != {"return_dict": True}:
                raise ValueError("Unsupported MOSS encoder call; refusing to drop optional outputs")
            hidden = [self.encoder(part, return_dict=True).last_hidden_state
                      for part in features.split(batch_size, dim=0)]
            return BaseModelOutput(last_hidden_state=torch.cat(hidden, dim=0))

    encoder = model.model.whisper_encoder
    if isinstance(encoder, ChunkedEncoder):
        raise ValueError("Encoder already wrapped")
    model.model.whisper_encoder = ChunkedEncoder(encoder).eval()

