#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <sys/resource.h>
#endif

#define WAV_HEADER_BYTES 44u
#define MAX_WAV_BYTES (7200000u + WAV_HEADER_BYTES)
#define MAX_AUDIO_FRAMES 1800000u

static int fail(const char *message) {
    fputs(message, stderr);
    fputc('\n', stderr);
    return 1;
}

static void secure_zero(void *memory, size_t length) {
    volatile unsigned char *bytes = (volatile unsigned char *)memory;
    while (length-- > 0u) *bytes++ = 0u;
}

static uint16_t read_u16_le(const unsigned char *bytes) {
    return (uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8u);
}

static uint32_t read_u32_le(const unsigned char *bytes) {
    return
        (uint32_t)bytes[0] |
        ((uint32_t)bytes[1] << 8u) |
        ((uint32_t)bytes[2] << 16u) |
        ((uint32_t)bytes[3] << 24u);
}

static int is_canonical_wav(const unsigned char *bytes, size_t length) {
    uint32_t data_bytes;
    if (length < WAV_HEADER_BYTES + 4u || length > MAX_WAV_BYTES) return 0;
    if (memcmp(bytes, "RIFF", 4u) != 0) return 0;
    if (read_u32_le(bytes + 4u) != length - 8u) return 0;
    if (memcmp(bytes + 8u, "WAVEfmt ", 8u) != 0) return 0;
    if (read_u32_le(bytes + 16u) != 16u) return 0;
    if (read_u16_le(bytes + 20u) != 3u) return 0;
    if (read_u16_le(bytes + 22u) != 1u) return 0;
    if (read_u32_le(bytes + 24u) != 24000u) return 0;
    if (read_u32_le(bytes + 28u) != 96000u) return 0;
    if (read_u16_le(bytes + 32u) != 4u) return 0;
    if (read_u16_le(bytes + 34u) != 32u) return 0;
    if (memcmp(bytes + 36u, "data", 4u) != 0) return 0;
    data_bytes = read_u32_le(bytes + 40u);
    if (data_bytes == 0u || data_bytes > MAX_AUDIO_FRAMES * 4u) return 0;
    if (data_bytes % 4u != 0u) return 0;
    return length == WAV_HEADER_BYTES + (size_t)data_bytes;
}

static int read_stdin(unsigned char **bytes_out, size_t *length_out) {
    size_t length;
    unsigned char *bytes = (unsigned char *)malloc(MAX_WAV_BYTES + 1u);
    if (bytes == NULL) return 0;

    length = fread(bytes, 1u, MAX_WAV_BYTES + 1u, stdin);
    if (ferror(stdin) || length > MAX_WAV_BYTES || !feof(stdin)) {
        secure_zero(bytes, length);
        free(bytes);
        return 0;
    }
    *bytes_out = bytes;
    *length_out = length;
    return 1;
}

static int initialize_decoder(
    const unsigned char *bytes,
    size_t length,
    ma_decoder *decoder
) {
    ma_uint64 frames = 0;
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 1u, 24000u);
    if (!is_canonical_wav(bytes, length)) return 0;
    if (ma_decoder_init_memory(bytes, length, &config, decoder) != MA_SUCCESS) {
        return 0;
    }
    if (
        ma_decoder_get_length_in_pcm_frames(decoder, &frames) != MA_SUCCESS ||
        frames == 0u ||
        frames > MAX_AUDIO_FRAMES ||
        frames * 4u != length - WAV_HEADER_BYTES
    ) {
        ma_decoder_uninit(decoder);
        return 0;
    }
    return 1;
}

static int play_decoder(ma_decoder *decoder) {
    ma_engine engine;
    ma_sound sound;
    if (ma_engine_init(NULL, &engine) != MA_SUCCESS) {
        return fail("audio device unavailable");
    }
    if (
        ma_sound_init_from_data_source(
            &engine,
            decoder,
            MA_SOUND_FLAG_NO_SPATIALIZATION,
            NULL,
            &sound
        ) != MA_SUCCESS
    ) {
        ma_engine_uninit(&engine);
        return fail("audio stream unavailable");
    }
    if (ma_sound_start(&sound) != MA_SUCCESS) {
        ma_sound_uninit(&sound);
        ma_engine_uninit(&engine);
        return fail("audio playback failed");
    }
    while (!ma_sound_at_end(&sound)) ma_sleep(5u);
    ma_sound_uninit(&sound);
    ma_engine_uninit(&engine);
    return 0;
}

int main(int argc, char **argv) {
    unsigned char *bytes = NULL;
    size_t length = 0u;
    ma_decoder decoder;
    int result;
    int check_only = argc == 2 && strcmp(argv[1], "--check") == 0;

#if defined(_WIN32)
    if (_setmode(_fileno(stdin), _O_BINARY) == -1) return fail("stdin unavailable");
#else
    {
        struct rlimit core_limit = {0u, 0u};
        (void)setrlimit(RLIMIT_CORE, &core_limit);
    }
#endif
    if (argc > 2 || (argc == 2 && !check_only)) return fail("invalid player operation");
    if (!read_stdin(&bytes, &length)) return fail("invalid or oversized WAV");
    if (!initialize_decoder(bytes, length, &decoder)) {
        secure_zero(bytes, length);
        free(bytes);
        return fail("invalid or oversized WAV");
    }

    result = check_only ? 0 : play_decoder(&decoder);
    ma_decoder_uninit(&decoder);
    secure_zero(bytes, length);
    free(bytes);
    return result;
}
