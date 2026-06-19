/*
 * SPDX-FileCopyrightText: 2026
 * SPDX-License-Identifier: Apache-2.0
 */
#include "usb_hid.h"

#include <string.h>

#include "class/hid/hid.h"
#include "class/hid/hid_device.h"
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"

#include "p4kvm_hw_defaults.h"

static const char *TAG = "usb_hid";

#define TUSB_DESC_TOTAL_LEN (TUD_CONFIG_DESC_LEN + CFG_TUD_HID * TUD_HID_DESC_LEN)

static const uint8_t s_hid_report_descriptor[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(HID_ITF_PROTOCOL_KEYBOARD)),
    TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(HID_ITF_PROTOCOL_MOUSE)),
};

static const char *s_string_descriptor[] = {
    (char[]){0x09, 0x04},
    "p4kvm",
    "p4kvm KVM HID",
    "0",
    "HID",
};

static const uint8_t s_configuration_descriptor[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(s_hid_report_descriptor), 0x81, 16, 10),
};

typedef enum {
    Q_MOUSE,
    Q_KEY,
} usb_hid_q_type_t;

typedef struct {
    usb_hid_q_type_t type;
    union {
        struct {
            uint8_t buttons;
            int8_t wheel;
            bool relative;
            uint16_t ax;
            uint16_t ay;
            int32_t rdx;
            int32_t rdy;
        } mouse;
        struct {
            uint8_t modifier;
            uint8_t keycode[6];
        } key;
    } u;
} usb_hid_q_msg_t;

static QueueHandle_t s_hid_q;
static TaskHandle_t s_hid_task;
static volatile bool s_usb_mounted;
static bool s_have_mouse;
static uint16_t s_last_mx;
static uint16_t s_last_my;

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance)
{
    (void)instance;
    return s_hid_report_descriptor;
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type,
                               uint8_t *buffer, uint16_t reqlen)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)reqlen;
    return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type,
                           uint8_t const *buffer, uint16_t bufsize)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)bufsize;
}

void tud_hid_report_complete_cb(uint8_t instance, uint8_t const *report, uint16_t len)
{
    (void)instance;
    (void)report;
    (void)len;
    if (s_hid_task) {
        xTaskNotifyGive(s_hid_task);
    }
}

static void tinyusb_on_event(tinyusb_event_t *event, void *arg)
{
    (void)arg;
    if (!event) {
        return;
    }
    switch (event->id) {
    case TINYUSB_EVENT_ATTACHED:
        s_usb_mounted = true;
        s_have_mouse = false;
        ESP_LOGI(TAG, "USB attached");
        break;
    case TINYUSB_EVENT_DETACHED:
        s_usb_mounted = false;
        s_have_mouse = false;
        ESP_LOGI(TAG, "USB detached");
        break;
    default:
        break;
    }
}

static bool wait_report_sent(void)
{
    return ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(80)) > 0;
}

static void send_mouse_segments(uint8_t buttons, int32_t dx, int32_t dy, int8_t wheel)
{
    const bool had_motion = (dx != 0 || dy != 0);
    while (dx != 0 || dy != 0) {
        int8_t sx = 0;
        int8_t sy = 0;
        if (dx > 0) {
            sx = (dx > 127) ? 127 : (int8_t)dx;
        } else if (dx < 0) {
            sx = (dx < -127) ? -127 : (int8_t)dx;
        }
        if (dy > 0) {
            sy = (dy > 127) ? 127 : (int8_t)dy;
        } else if (dy < 0) {
            sy = (dy < -127) ? -127 : (int8_t)dy;
        }
        tud_hid_mouse_report(HID_ITF_PROTOCOL_MOUSE, buttons, sx, sy, 0, 0);
        if (!wait_report_sent()) {
            ESP_LOGD(TAG, "mouse segment timeout");
        }
        dx -= sx;
        dy -= sy;
    }
    if (wheel != 0) {
        tud_hid_mouse_report(HID_ITF_PROTOCOL_MOUSE, buttons, 0, 0, wheel, 0);
        (void)wait_report_sent();
    } else if (!had_motion) {
        /* Press/release with no mickey motion: still emit a report or clicks never reach the host. */
        tud_hid_mouse_report(HID_ITF_PROTOCOL_MOUSE, buttons, 0, 0, 0, 0);
        (void)wait_report_sent();
    }
}

static void process_mouse_abs(const usb_hid_q_msg_t *m)
{
    uint16_t x = m->u.mouse.ax;
    uint16_t y = m->u.mouse.ay;
    uint8_t buttons = m->u.mouse.buttons;
    int8_t wheel = m->u.mouse.wheel;

    if (x >= P4KVM_CSI_H_RES) {
        x = P4KVM_CSI_H_RES - 1;
    }
    if (y >= P4KVM_CSI_V_RES) {
        y = P4KVM_CSI_V_RES - 1;
    }

    if (!s_have_mouse) {
        s_last_mx = x;
        s_last_my = y;
        s_have_mouse = true;
        if (wheel != 0) {
            tud_hid_mouse_report(HID_ITF_PROTOCOL_MOUSE, buttons, 0, 0, wheel, 0);
            (void)wait_report_sent();
        } else if (buttons != 0) {
            tud_hid_mouse_report(HID_ITF_PROTOCOL_MOUSE, buttons, 0, 0, 0, 0);
            (void)wait_report_sent();
        }
        return;
    }

    int32_t dx = (int32_t)x - (int32_t)s_last_mx;
    int32_t dy = (int32_t)y - (int32_t)s_last_my;
    s_last_mx = x;
    s_last_my = y;

    send_mouse_segments(buttons, dx, dy, wheel);
}

static void process_mouse_rel(const usb_hid_q_msg_t *m)
{
    uint8_t buttons = m->u.mouse.buttons;
    int8_t wheel = m->u.mouse.wheel;
    int32_t dx = (int32_t)m->u.mouse.rdx;
    int32_t dy = (int32_t)m->u.mouse.rdy;

    if (!s_have_mouse) {
        s_have_mouse = true;
    }

    int32_t nx = (int32_t)s_last_mx + dx;
    int32_t ny = (int32_t)s_last_my + dy;
    if (nx < 0) {
        nx = 0;
    } else if (nx >= P4KVM_CSI_H_RES) {
        nx = P4KVM_CSI_H_RES - 1;
    }
    if (ny < 0) {
        ny = 0;
    } else if (ny >= P4KVM_CSI_V_RES) {
        ny = P4KVM_CSI_V_RES - 1;
    }
    s_last_mx = (uint16_t)nx;
    s_last_my = (uint16_t)ny;

    send_mouse_segments(buttons, dx, dy, wheel);
}

static void process_mouse_msg(const usb_hid_q_msg_t *m);

static void merge_mouse_msgs(usb_hid_q_msg_t *acc, const usb_hid_q_msg_t *add)
{
    if (acc->u.mouse.relative != add->u.mouse.relative) {
        process_mouse_msg(acc);
        *acc = *add;
        return;
    }
    acc->u.mouse.buttons = add->u.mouse.buttons;
    int w = (int)acc->u.mouse.wheel + (int)add->u.mouse.wheel;
    if (w > 127) {
        w = 127;
    } else if (w < -127) {
        w = -127;
    }
    acc->u.mouse.wheel = (int8_t)w;
    if (acc->u.mouse.relative) {
        acc->u.mouse.rdx += add->u.mouse.rdx;
        acc->u.mouse.rdy += add->u.mouse.rdy;
    } else {
        acc->u.mouse.ax = add->u.mouse.ax;
        acc->u.mouse.ay = add->u.mouse.ay;
    }
}

static void process_mouse_msg(const usb_hid_q_msg_t *m)
{
    if (m->u.mouse.relative) {
        process_mouse_rel(m);
    } else {
        process_mouse_abs(m);
    }
}

static void hid_worker(void *arg)
{
    (void)arg;
    usb_hid_q_msg_t msg;
    for (;;) {
        if (xQueueReceive(s_hid_q, &msg, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        if (!tud_mounted()) {
            continue;
        }
        if (msg.type == Q_KEY) {
            tud_hid_keyboard_report(HID_ITF_PROTOCOL_KEYBOARD, msg.u.key.modifier, msg.u.key.keycode);
            (void)wait_report_sent();
            continue;
        }

        usb_hid_q_msg_t acc = msg;
        for (;;) {
            usb_hid_q_msg_t next;
            if (xQueueReceive(s_hid_q, &next, 0) != pdTRUE) {
                process_mouse_msg(&acc);
                break;
            }
            if (!tud_mounted()) {
                break;
            }
            if (next.type == Q_KEY) {
                process_mouse_msg(&acc);
                tud_hid_keyboard_report(HID_ITF_PROTOCOL_KEYBOARD, next.u.key.modifier, next.u.key.keycode);
                (void)wait_report_sent();
                break;
            }
            merge_mouse_msgs(&acc, &next);
        }
    }
}

bool usb_hid_ready(void)
{
    return s_usb_mounted && tud_mounted();
}

void usb_hid_mouse(uint8_t buttons, uint16_t abs_x, uint16_t abs_y, int8_t wheel)
{
    if (!s_hid_q) {
        return;
    }
    usb_hid_q_msg_t m = {
        .type = Q_MOUSE,
        .u =
            {
                .mouse =
                    {
                        .buttons = buttons,
                        .wheel = wheel,
                        .relative = false,
                        .ax = abs_x,
                        .ay = abs_y,
                        .rdx = 0,
                        .rdy = 0,
                    },
            },
    };
    (void)xQueueSend(s_hid_q, &m, 0);
}

void usb_hid_mouse_rel(uint8_t buttons, int16_t dx, int16_t dy, int8_t wheel)
{
    if (!s_hid_q) {
        return;
    }
    usb_hid_q_msg_t m = {
        .type = Q_MOUSE,
        .u =
            {
                .mouse =
                    {
                        .buttons = buttons,
                        .wheel = wheel,
                        .relative = true,
                        .ax = 0,
                        .ay = 0,
                        .rdx = (int32_t)dx,
                        .rdy = (int32_t)dy,
                    },
            },
    };
    (void)xQueueSend(s_hid_q, &m, 0);
}

void usb_hid_keyboard(uint8_t modifier, const uint8_t keycode[6])
{
    if (!s_hid_q || !keycode) {
        return;
    }
    usb_hid_q_msg_t m = {.type = Q_KEY};
    m.u.key.modifier = modifier;
    memcpy(m.u.key.keycode, keycode, 6);
    (void)xQueueSend(s_hid_q, &m, 0);
}

esp_err_t usb_hid_init(void)
{
    if (s_hid_q) {
        return ESP_OK;
    }

    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_RETURN_ON_ERROR(err, TAG, "gpio_install_isr_service");
    }

    s_hid_q = xQueueCreate(192, sizeof(usb_hid_q_msg_t));
    ESP_RETURN_ON_FALSE(s_hid_q, ESP_ERR_NO_MEM, TAG, "queue");

    tinyusb_config_t tusb_cfg = TINYUSB_DEFAULT_CONFIG(tinyusb_on_event);
    tusb_cfg.descriptor.device = NULL;
    tusb_cfg.descriptor.full_speed_config = s_configuration_descriptor;
    tusb_cfg.descriptor.string = s_string_descriptor;
    tusb_cfg.descriptor.string_count = sizeof(s_string_descriptor) / sizeof(s_string_descriptor[0]);
#if (TUD_OPT_HIGH_SPEED)
    tusb_cfg.descriptor.high_speed_config = s_configuration_descriptor;
#endif

    ESP_RETURN_ON_ERROR(tinyusb_driver_install(&tusb_cfg), TAG, "tinyusb_driver_install");

    /* Above stream/httpd work so HID reports are not delayed by MJPEG or WS parsing. */
    BaseType_t ok = xTaskCreate(hid_worker, "usb_hid", 4096, NULL, tskIDLE_PRIORITY + 8, &s_hid_task);
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_ERR_NO_MEM, TAG, "task");

    return ESP_OK;
}
