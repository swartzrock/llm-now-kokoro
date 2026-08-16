#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

#define MAX_WAV_BYTES (7200000u + 44u)
#define MAX_AUDIO_FRAMES 1800000u

static int fail(const char *message) {
    fputs(message, stderr);
    fputc('\n', stderr);
    return 1;
}

static int read_stdin(unsigned char **bytes_out, size_t *length_out) {
    size_t capacity = 65536;
    size_t length = 0;
    unsigned char *bytes = (unsigned char *)malloc(capacity);
    if (bytes == NULL) return 0;

    for (;;) {
        size_t available = capacity - length;
        size_t count = fread(bytes + length, 1, available, stdin);
        length += count;
        if (length > MAX_WAV_BYTES) {
            free(bytes);
            return 0;
        }
        if (count < available) {
            if (ferror(stdin)) {
                free(bytes);
                return 0;
            }
            break;
        }
        if (capacity >= MAX_WAV_BYTES + 1u) {
            free(bytes);
            return 0;
        }
        capacity *= 2u;
        if (capacity > MAX_WAV_BYTES + 1u) capacity = MAX_WAV_BYTES + 1u;
        unsigned char *larger = (unsigned char *)realloc(bytes, capacity);
        if (larger == NULL) {
            free(bytes);
            return 0;
        }
        bytes = larger;
    }

    *bytes_out = bytes;
    *length_out = length;
    return length > 44u;
}

static int initialize_decoder(
    const unsigned char *bytes,
    size_t length,
    ma_decoder *decoder
) {
    ma_uint64 frames = 0;
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 1, 24000);
    if (ma_decoder_init_memory(bytes, length, &config, decoder) != MA_SUCCESS) {
        return 0;
    }
    if (
        ma_decoder_get_length_in_pcm_frames(decoder, &frames) != MA_SUCCESS ||
        frames == 0 ||
        frames > MAX_AUDIO_FRAMES
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
    while (!ma_sound_at_end(&sound)) ma_sleep(5);
    ma_sound_uninit(&sound);
    ma_engine_uninit(&engine);
    return 0;
}

int main(int argc, char **argv) {
    unsigned char *bytes = NULL;
    size_t length = 0;
    ma_decoder decoder;
    int check_only = argc == 2 && strcmp(argv[1], "--check") == 0;

    if (argc > 2 || (argc == 2 && !check_only)) return fail("invalid player operation");
#if defined(_WIN32)
    if (_setmode(_fileno(stdin), _O_BINARY) == -1) return fail("stdin unavailable");
#endif
    if (!read_stdin(&bytes, &length)) return fail("invalid or oversized WAV");
    if (!initialize_decoder(bytes, length, &decoder)) {
        free(bytes);
        return fail("invalid or oversized WAV");
    }

    int result = check_only ? 0 : play_decoder(&decoder);
    ma_decoder_uninit(&decoder);
    memset(bytes, 0, length);
    free(bytes);
    return result;
}
