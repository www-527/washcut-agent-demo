from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import app as gateway
from app import GatewayError, _alignment_payload


class AlignmentPayloadTest(TestCase):
    def test_accepts_official_forced_align_result_shape(self) -> None:
        result = SimpleNamespace(
            items=[
                SimpleNamespace(text="洗", start_time=0.1, end_time=0.2),
                SimpleNamespace(text="车", start_time=0.2, end_time=0.35),
            ]
        )

        payload = _alignment_payload([result])

        self.assertEqual(payload["words"][0], {"text": "洗", "startMs": 100, "endMs": 200})
        self.assertEqual(payload["segments"][0]["text"], "洗车")
        self.assertEqual(payload["segments"][0]["endMs"], 350)

    def test_rejects_missing_item_list(self) -> None:
        with self.assertRaises(GatewayError) as raised:
            _alignment_payload([SimpleNamespace()])

        self.assertEqual(raised.exception.code, "QWEN_ALIGN_INVALID_RESULT")


class ModelLifecycleTest(TestCase):
    def tearDown(self) -> None:
        gateway._asr_model = None
        gateway._align_model = None
        gateway._load_error = None

    def test_health_is_passive_and_does_not_load_models(self) -> None:
        gateway._asr_model = None
        gateway._align_model = None

        payload = gateway._health_payload()

        self.assertFalse(payload["ready"])
        self.assertFalse(payload["asr"]["ready"])
        self.assertFalse(payload["aligner"]["ready"])

    def test_inference_requires_explicit_activation(self) -> None:
        with self.assertRaises(GatewayError) as raised:
            gateway._require_models_loaded()

        self.assertEqual(raised.exception.code, "QWEN_MODELS_NOT_LOADED")

    def test_unload_drops_references_and_confirms_empty_cuda_cache(self) -> None:
        class FakeCuda:
            def is_available(self) -> bool: return True
            def synchronize(self) -> None: pass
            def empty_cache(self) -> None: pass
            def ipc_collect(self) -> None: pass
            def memory_allocated(self) -> int: return 0
            def memory_reserved(self) -> int: return 0

        gateway._asr_model = object()
        gateway._align_model = object()
        fake_torch = SimpleNamespace(cuda=FakeCuda())

        with patch.dict(gateway.sys.modules, {"torch": fake_torch}):
            payload = gateway._unload_models()

        self.assertIsNone(gateway._asr_model)
        self.assertIsNone(gateway._align_model)
        self.assertFalse(payload["ready"])
        self.assertTrue(payload["gpuMemoryReleased"])
        self.assertEqual(payload["gpuMemory"], {"allocatedBytes": 0, "reservedBytes": 0})
