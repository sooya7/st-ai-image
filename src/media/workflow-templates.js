/**
 * 内置的 ComfyUI 生图工作流模板（API 格式，已标好占位符）。
 * 模型文件名按官方发布的写；本机文件名不一样就在工作流里改。
 */

const decodeAndSave = (samples, vae) => ({
    8: { class_type: 'VAEDecode', inputs: { samples, vae } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'st-ai-image', images: ['8', 0] } },
});

export const WORKFLOW_TEMPLATES = {
    // SD1.5 / SDXL / Illustrious / NoobAI / Pony 这类单文件 checkpoint；模型用面板的模型栏（可以点刷新拉列表）
    'SDXL（单个 checkpoint）': {
        3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: 28, cfg: 6, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
        4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%MODEL_NAME%' } },
        5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] } },
        7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 1] } },
        ...decodeAndSave(['3', 0], ['4', 2]),
    },
    // circlestone-labs/Anima，参数照 ComfyUI 官方模板：30 步、CFG 4、euler / simple
    'Anima': {
        1: { class_type: 'UNETLoader', inputs: { unet_name: 'anima-base-v1.0.safetensors', weight_dtype: 'default' } },
        2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } },
        4: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
        5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['2', 0] } },
        7: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia, %negative_prompt%', clip: ['2', 0] } },
        3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: 30, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
        ...decodeAndSave(['3', 0], ['4', 0]),
    },
};
