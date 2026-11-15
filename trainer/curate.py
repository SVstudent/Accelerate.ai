#!/usr/bin/env python3
"""Perception: CLIP embeddings + linear probe + held-out pool (CLAUDE.md §2).

Uses HuggingFace `transformers` CLIPModel (openai/clip-vit-base-patch32 — the
same ViT-B/32 weights open_clip would load) because `open_clip_torch` pulls
torchvision and the whole CUDA stack: measured [Errno 28] No space left on
device in a 3 GB Daytona sandbox. transformers' CLIP needs only torch, numpy
and PIL and settles at 1.2 GB.

zero_shot_acc is the BEFORE (CLIP prompts, near chance on these classes),
probe_acc is the AFTER (logistic regression on the same embeddings). The gap is
what the web data bought, and the pool is what the policy actually consumes.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cpu_tune  # noqa: E402  — must precede numpy/torch

import numpy as np  # noqa: E402
from contracts import SandboxJob  # noqa: E402
from db_neon import NeonWriter  # noqa: E402
from perception import PerceptionPool  # noqa: E402


# CLIP ViT-B/32 preprocessing, from the model card. Implemented here because
# transformers v5 removed the slow image processors and the fast one requires
# torchvision, whose CUDA wheels do not fit the sandbox disk.
CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)
CLIP_RES = 224


def clip_pixel_values(images) -> "np.ndarray":
    """PIL images -> float32 NCHW tensor data, resized + centre-cropped + normalised."""
    from PIL import Image
    out = np.zeros((len(images), 3, CLIP_RES, CLIP_RES), dtype=np.float32)
    mean = np.asarray(CLIP_MEAN, dtype=np.float32).reshape(3, 1, 1)
    std = np.asarray(CLIP_STD, dtype=np.float32).reshape(3, 1, 1)
    for i, im in enumerate(images):
        im = im.convert("RGB")
        w, h = im.size
        scale = CLIP_RES / min(w, h)                      # shortest side -> 224
        im = im.resize((max(CLIP_RES, round(w * scale)), max(CLIP_RES, round(h * scale))),
                       Image.BICUBIC)
        w, h = im.size
        left = (w - CLIP_RES) // 2
        top = (h - CLIP_RES) // 2
        im = im.crop((left, top, left + CLIP_RES, top + CLIP_RES))
        arr = np.asarray(im, dtype=np.float32).transpose(2, 0, 1) / 255.0
        out[i] = (arr - mean) / std
    return out


def wilson_interval(correct: int, n: int, z: float = 1.96):
    """95% Wilson score interval for a binomial proportion.

    n_val is small (tens of images), so a bare "probe_acc 1.000" is not an
    honest number: 13/13 correct is also consistent with a true accuracy of
    0.77. Wilson behaves at the 0/n and n/n edges where the normal
    approximation degenerates to a zero-width interval, so the UI can show
    "100% (77-100%)" instead of implying certainty we do not have.
    """
    if n <= 0:
        return 0.0, 1.0
    p = correct / n
    denom = 1.0 + (z * z) / n
    centre = (p + (z * z) / (2 * n)) / denom
    half = (z / denom) * math.sqrt(p * (1.0 - p) / n + (z * z) / (4 * n * n))
    return max(0.0, centre - half), min(1.0, centre + half)


def embed_with_tta(model, torch, imgs, batch=32):
    """Unit-normalised CLIP image embeddings, horizontal-flip test-time averaged.

    Each image is embedded twice — as-is and mirrored — and the two unit
    vectors are averaged and re-normalised. One extra forward pass per image;
    no extra preprocessing (the flip is a numpy view of the already-normalised
    NCHW batch, so clip_pixel_values stays the only preprocessing path and we
    still need neither torchvision nor open_clip, which do not fit the
    sandbox's 3 GiB disk). On a few-dozen-image probe this measurably steadies
    the embeddings: a mirrored leaf is the same leaf, and averaging cancels the
    part of the embedding that only encodes which way it happened to point.
    """
    chunks = []
    for i in range(0, len(imgs), batch):
        px = clip_pixel_values(imgs[i:i + batch])
        flipped = np.ascontiguousarray(px[:, :, :, ::-1])   # mirror on width
        acc = None
        for arr in (px, flipped):
            f = model.get_image_features(pixel_values=torch.from_numpy(arr))
            f = f / f.norm(dim=-1, keepdim=True)
            acc = f if acc is None else acc + f
        acc = acc / acc.norm(dim=-1, keepdim=True)          # re-normalise
        chunks.append(acc)
    return torch.cat(chunks).cpu().numpy()


def fit_probe(feats, y, mask):
    """Logistic probe on one training mask, or None when it cannot be fitted.

    C=1.0 on ~40 samples of 512-dim CLIP features shrinks the coefficients so
    hard that probabilities collapse toward 0.5: a measured run had probe_auc
    1.00 (perfect ranking) but pool_separation only 0.299, so p_target carried
    almost no usable signal to the policy. Less shrinkage keeps the margin.
    """
    from sklearn.linear_model import LogisticRegression
    if int(mask.sum()) < 4 or len(np.unique(y[mask])) < 2:
        return None
    p = LogisticRegression(
        max_iter=5000,
        C=float(os.environ.get("PROBE_C", "50")),
        class_weight="balanced",
    )
    p.fit(feats[mask], y[mask])
    return p


def prob_mapping(probe, feats, y, tr):
    """The p_target mapping the policy consumes, chosen on the TRAIN split only.

    Measured: with C=1 the raw probabilities collapse toward 0.5 (separation
    0.05-0.30 even at AUC 1.0), so p_target carried almost no signal. Raising C
    recovers most of it. Rescaling the margin by its own spread can help
    further, but NOT always — on a well-fit probe it can shrink separation. So
    the two are compared empirically, and never on val/pool, which would leak.
    """
    scale = float(np.std(probe.decision_function(feats[tr]))) or 1.0

    def raw_prob(X):
        return probe.predict_proba(X)[:, 1]

    def sharp_prob(X):
        return 1.0 / (1.0 + np.exp(-2.5 * (probe.decision_function(X) / scale)))

    def sep(fn):
        p = fn(feats[tr])
        if not (y[tr] == 1).any() or not (y[tr] == 0).any():
            return 0.0
        return float(p[y[tr] == 1].mean() - p[y[tr] == 0].mean())

    use_sharp = sep(sharp_prob) > sep(raw_prob)
    return (
        (sharp_prob if use_sharp else raw_prob),
        ("margin-sharpened" if use_sharp else "raw-probability"),
        {"train_sep_raw": round(sep(raw_prob), 4), "train_sep_sharp": round(sep(sharp_prob), 4)},
    )


def score_split(probe, feats, y, mask):
    """Accuracy + 95% Wilson interval + AUC on one held-out mask.

    Returns None for an empty mask, so a caller reports "not measured" instead
    of a zero that looks like a measurement.
    """
    from sklearn.metrics import roc_auc_score
    n = int(mask.sum())
    if n == 0 or probe is None:
        return None
    pred = probe.predict(feats[mask])
    correct = int((pred == y[mask]).sum())
    lo, hi = wilson_interval(correct, n)
    auc = None
    if len(np.unique(y[mask])) > 1:
        try:
            auc = float(roc_auc_score(y[mask], probe.predict_proba(feats[mask])[:, 1]))
        except Exception:
            auc = None
    # the confusion matrix matters here, not just accuracy: adding positives
    # shifts the boundary, which can raise accuracy on a one-class held-out set
    # while costing precision elsewhere. Reporting both makes that visible.
    tp = int(((pred == 1) & (y[mask] == 1)).sum())
    fp = int(((pred == 1) & (y[mask] == 0)).sum())
    fn = int(((pred == 0) & (y[mask] == 1)).sum())
    tn = int(((pred == 0) & (y[mask] == 0)).sum())
    return {
        "n": n,
        "correct": correct,
        "acc": round(float(correct / n), 4),
        "ci_low": round(lo, 4),
        "ci_high": round(hi, 4),
        "auc": None if auc is None else round(auc, 4),
        "confusion": [[tn, fp], [fn, tp]],
        "precision_target": None if (tp + fp) == 0 else round(tp / (tp + fp), 4),
        "recall_target": None if (tp + fn) == 0 else round(tp / (tp + fn), 4),
    }


def pool_quality(probe, feats, y, tr, pool_mask, band=(0.4, 0.6)):
    """What the policy actually gets handed: separation, overlap, mapping used."""
    if probe is None or not pool_mask.any():
        return None
    prob_fn, mapping, detail = prob_mapping(probe, feats, y, tr)
    p = prob_fn(feats[pool_mask])
    yp = y[pool_mask]
    sep = (
        float(p[yp == 1].mean() - p[yp == 0].mean())
        if (yp == 1).any() and (yp == 0).any() else 0.0
    )
    return {
        "pool_separation": round(sep, 4),
        "pool_overlap": round(float(((p >= band[0]) & (p <= band[1])).mean()), 4),
        "p_target_mapping": mapping,
        "mapping_detail": detail,
    }


def hard_negative_ablation(feats, y, split, hard, pool_mask):
    """Measure what the mined look-alikes actually bought.

    Two probes, one comparison:
      · BEFORE — fitted on the plain training images only, i.e. exactly the
        dataset this pipeline built before look-alike mining existed;
      · AFTER  — fitted on the same plain images PLUS the mined look-alikes.

    Both are then scored on the SAME held-out images, reported three ways: the
    plain val split (did we break the easy case?), the look-alike val split
    (the case that breaks a real machine) and the union. The splits are assigned
    separately for plain and look-alike images in the Curator, so the plain
    held-out set here is identical to the one the BEFORE probe would have been
    scored on anyway.

    Returns None when there are no look-alikes, or when one of the two probes
    cannot be fitted — never a fabricated delta.
    """
    tr, val = split == "train", split == "val"
    if not hard.any() or not (val & hard).any():
        return None

    probe_before = fit_probe(feats, y, tr & ~hard)
    probe_after = fit_probe(feats, y, tr)
    if probe_before is None or probe_after is None:
        return None

    def side(probe, train_mask, label):
        out = {
            "fitted_on": label,
            "n_train": int(train_mask.sum()),
            "plain_val": score_split(probe, feats, y, val & ~hard),
            "lookalike_val": score_split(probe, feats, y, val & hard),
            "full_val": score_split(probe, feats, y, val),
        }
        pq = pool_quality(probe, feats, y, train_mask, pool_mask)
        if pq:
            out.update(pq)
        return out

    before = side(probe_before, tr & ~hard, "plain training images only")
    after = side(probe_after, tr, "plain + mined look-alikes")

    def d(path, field="acc"):
        a, b = after.get(path), before.get(path)
        if not a or not b or a.get(field) is None or b.get(field) is None:
            return None
        return round(float(a[field] - b[field]), 4)

    return {
        "n_hard_negatives": int(hard.sum()),
        "n_hard_train": int((tr & hard).sum()),
        "n_hard_val": int((val & hard).sum()),
        "n_hard_pool": int((pool_mask & hard).sum()),
        "before": before,
        "after": after,
        "delta": {
            "plain_val_acc": d("plain_val"),
            "lookalike_val_acc": d("lookalike_val"),
            "full_val_acc": d("full_val"),
            "pool_separation": (
                None
                if before.get("pool_separation") is None or after.get("pool_separation") is None
                else round(after["pool_separation"] - before["pool_separation"], 4)
            ),
            "pool_overlap": (
                None
                if before.get("pool_overlap") is None or after.get("pool_overlap") is None
                else round(after["pool_overlap"] - before["pool_overlap"], 4)
            ),
        },
    }


def load_images(items, max_px=224):
    """Decode the bytes the Curator already downloaded (via Bright Data)."""
    from PIL import Image
    out, keep = [], []
    for it in items:
        p = it.get("path") or it.get("file")
        if not p or not os.path.exists(p):
            continue
        try:
            im = Image.open(p).convert("RGB")
            im.thumbnail((max_px * 2, max_px * 2))
            out.append(im)
            keep.append(it)
        except Exception:
            continue
    return out, keep


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    args = ap.parse_args()
    job = SandboxJob.model_validate_json(open(args.job).read())
    assert job.job == "curate", f"curate.py got job={job.job}"

    neon = NeonWriter()
    items = job.dataset or []
    classes = job.classes or {"target": "weed", "protect": "crop"}

    import torch
    cpu_tune.tune_torch()
    from transformers import CLIPModel, CLIPTokenizer
    from sklearn.metrics import roc_auc_score, confusion_matrix

    MODEL_ID = "openai/clip-vit-base-patch32"
    model = CLIPModel.from_pretrained(MODEL_ID)
    tokenizer = CLIPTokenizer.from_pretrained(MODEL_ID)
    model.eval()

    imgs, kept = load_images(items)
    if len(kept) < 20:
        print(f"[curate] only {len(kept)} usable images; aborting", flush=True)
        return 2

    with torch.no_grad():
        # embed in batches so a big dataset cannot blow the sandbox's memory,
        # each image averaged with its mirror (test-time augmentation)
        feats = embed_with_tta(model, torch, imgs, batch=32)

        # zero-shot BEFORE: generic prompts, nothing trained on our classes
        prompts = [f"a photo of {classes['protect']}", f"a photo of {classes['target']}"]
        t_inputs = tokenizer(prompts, return_tensors="pt", padding=True)
        txt = model.get_text_features(**t_inputs)
        txt = (txt / txt.norm(dim=-1, keepdim=True)).cpu().numpy()

    y = np.asarray([1 if it["class_key"] == "target" else 0 for it in kept])
    split = np.asarray([it.get("split", "train") for it in kept])
    # look-alikes mined on purpose by the Curator (migration 0003). Everything
    # below works unchanged when there are none: `hard` is then all-False and
    # the shipped probe is the same probe as before.
    hard = np.asarray([bool(it.get("hard_negative")) for it in kept])

    zs_pred = (feats @ txt.T).argmax(axis=1)
    val = split == "val"
    zero_shot_acc = float((zs_pred[val] == y[val]).mean()) if val.any() else float((zs_pred == y).mean())

    tr = split == "train"
    probe = fit_probe(feats, y, tr)
    if probe is None:
        print("[curate] training split has only one class; aborting", flush=True)
        return 2
    # score on val when we have one, else fall back to train (and say so via
    # probe_acc_on, because a train-fit accuracy is not a held-out number)
    ev = val if val.any() else tr
    probe_acc_on = "val" if val.any() else "train"
    ev_correct = int((probe.predict(feats[ev]) == y[ev]).sum())
    ev_n = int(ev.sum())
    probe_acc = float(ev_correct / ev_n) if ev_n else 0.0
    # honest uncertainty: n is tens of images, so report the interval too
    ci_low, ci_high = wilson_interval(ev_correct, ev_n)
    p_val = probe.predict_proba(feats[ev])[:, 1]
    try:
        auc = float(roc_auc_score(y[ev], p_val))
    except Exception:
        auc = 0.0
    cm = confusion_matrix(y[ev], probe.predict(feats[ev])).tolist() if ev_n else [[0, 0], [0, 0]]

    # ── the pool: held-out images the sim draws from ──
    pool_mask = split == "pool"
    if not pool_mask.any():
        pool_mask = val

    # Map the probe's output to the p_target the policy consumes (chosen on the
    # train split only — see prob_mapping).
    prob_fn, mapping, mapping_detail = prob_mapping(probe, feats, y, tr)
    print(f"[curate] p_target mapping: {mapping} "
          f"(train sep raw={mapping_detail['train_sep_raw']:.3f} "
          f"sharp={mapping_detail['train_sep_sharp']:.3f})", flush=True)

    p_pool = prob_fn(feats[pool_mask])
    y_pool = y[pool_mask]
    ids_pool = [kept[i]["id"] for i in np.flatnonzero(pool_mask)]
    pool = PerceptionPool(
        p_pool[y_pool == 1], [ids_pool[i] for i in np.flatnonzero(y_pool == 1)],
        p_pool[y_pool == 0], [ids_pool[i] for i in np.flatnonzero(y_pool == 0)],
    )
    # pool quality: separation is the mean p_target gap the policy gets to see;
    # overlap is the share of pool images stuck in the ambiguous band, i.e. how
    # much of what we feed the policy is mush it cannot act on.
    band_lo, band_hi = 0.4, 0.6
    pool_overlap = (
        float(((p_pool >= band_lo) & (p_pool <= band_hi)).mean()) if p_pool.size else 1.0
    )

    pool.save("/tmp/perception_pool.npz")
    pool_art = neon.put_artifact("perception_pool", "application/octet-stream",
                                 open("/tmp/perception_pool.npz", "rb").read())

    metrics = {
        "n_train": int(tr.sum()), "n_val": int(val.sum()),
        "n_pool": int(pool_mask.sum()), "n_rejected": int(len(items) - len(kept)),
        "zero_shot_acc": round(zero_shot_acc, 4),
        "probe_acc": round(probe_acc, 4),
        # 95% Wilson interval on the same split probe_acc was measured on —
        # the UI must show this next to probe_acc, never the bare point estimate
        "probe_acc_ci_low": round(ci_low, 4),
        "probe_acc_ci_high": round(ci_high, 4),
        "probe_acc_n": ev_n,
        "probe_acc_on": probe_acc_on,
        "probe_auc": round(auc, 4),
        "confusion": cm,
        "pool_separation": round(float(pool.separation), 4),
        "pool_overlap": round(pool_overlap, 4),
        "pool_ambiguous_band": [band_lo, band_hi],
        "probe_C": float(os.environ.get("PROBE_C", "50")),
        "p_target_mapping": mapping,
        "tta": "hflip-mean",
        # the plain-only held-out number, so a run WITH mined look-alikes can
        # still be compared against runs from before they existed
        "probe_acc_plain_val": (
            None if not (val & ~hard).any()
            else score_split(probe, feats, y, val & ~hard)["acc"]
        ),
        "n_hard_negatives": int(hard.sum()),
    }

    # ── what the mined look-alikes bought, measured on the same held-out set ──
    ablation = hard_negative_ablation(feats, y, split, hard, pool_mask)
    if ablation:
        metrics["hard_negative_ablation"] = ablation
        b, a, d = ablation["before"], ablation["after"], ablation["delta"]
        la_b = (b.get("lookalike_val") or {}).get("acc")
        la_a = (a.get("lookalike_val") or {}).get("acc")
        print(
            f"[curate] hard-negative ablation ({ablation['n_hard_train']} mined look-alikes "
            f"in train, {ablation['n_hard_val']} held out): "
            f"look-alike val acc {la_b} -> {la_a} (delta {d['lookalike_val_acc']}), "
            f"plain val acc {(b.get('plain_val') or {}).get('acc')} -> "
            f"{(a.get('plain_val') or {}).get('acc')} (delta {d['plain_val_acc']}), "
            f"pool separation {b.get('pool_separation')} -> {a.get('pool_separation')}",
            flush=True,
        )
    else:
        print("[curate] no hard-negative ablation (no mined look-alikes in this dataset)",
              flush=True)

    print("[curate] " + json.dumps(metrics), flush=True)
    print("PERCEPTION_METRICS_JSON=" + json.dumps(
        {**metrics, "pool_artifact_id": pool_art}), flush=True)
    neon.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
