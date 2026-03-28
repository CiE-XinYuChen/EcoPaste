import { useMount } from "ahooks";
import { cloneDeep } from "es-toolkit";
import { isEmpty, remove } from "es-toolkit/compat";
import { nanoid } from "nanoid";
import {
  type ClipboardChangeOptions,
  onClipboardChange,
  startListening,
  writeText,
} from "tauri-plugin-clipboard-x-api";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { readFile } from "@tauri-apps/plugin-fs";
import { RTFJS } from "rtf.js";
import { fullName } from "tauri-plugin-fs-pro-api";
import {
  insertHistory,
  selectHistory,
  updateHistory,
} from "@/database/history";
import type { State } from "@/pages/Main";
import { getClipboardTextSubtype } from "@/plugins/clipboard";
import { clipboardStore } from "@/stores/clipboard";
import type { DatabaseSchemaHistory } from "@/types/database";
import { formatDate } from "@/utils/dayjs";

const extractPlainTextFromRtf = async (rtfContent: Uint8Array): Promise<string> => {
  const buffer = rtfContent.buffer.slice(
    rtfContent.byteOffset,
    rtfContent.byteOffset + rtfContent.byteLength,
  ) as ArrayBuffer;
  const doc = new RTFJS.Document(buffer, {});
  const elements = await doc.render();
  return elements.map((el) => el.textContent ?? "").join("").trim();
};

export const useClipboard = (
  state: State,
  options?: ClipboardChangeOptions,
) => {
  useMount(async () => {
    await startListening();

    let skipNextChange = false;

    onClipboardChange(async (result) => {
      const { files, image, html, rtf, text } = result;

      if (isEmpty(result) || Object.values(result).every(isEmpty)) return;

      const { copyPlain, convertRtfToPlain } = clipboardStore.content;

      // If we just wrote plain text back, skip this event to avoid loop
      if (skipNextChange) {
        skipNextChange = false;
        return;
      }

      // Auto-convert RTF to plain text if enabled
      if (rtf && text?.value && convertRtfToPlain) {
        skipNextChange = true;
        await writeText(text.value);
        sendNotification({
          title: "EcoPaste",
          body: "剪贴板内容已转换为纯文本",
        });
        return;
      }

      // Auto-convert .rtfd / .rtf files to plain text if enabled
      if (files && convertRtfToPlain) {
        const fileList: string[] = Array.isArray(files.value) ? files.value : [files.value];
        const rtfFile = fileList.find((f) => f.endsWith(".rtfd") || f.endsWith(".rtf"));
        if (rtfFile) {
          const rtfPath = rtfFile.endsWith(".rtfd") ? `${rtfFile}/TXT.rtf` : rtfFile;
          try {
            const bytes = await readFile(rtfPath);
            const plain = await extractPlainTextFromRtf(bytes);
            if (plain) {
              skipNextChange = true;
              await writeText(plain);
              sendNotification({
                title: "EcoPaste",
                body: "剪贴板内容已转换为纯文本",
              });
              return;
            }
          } catch {
            // 解析失败则按普通文件处理
          }
        }
      }

      const data = {
        createTime: formatDate(),
        favorite: false,
        group: "text",
        id: nanoid(),
        search: text?.value,
      } as DatabaseSchemaHistory;

      if (files) {
        Object.assign(data, files, {
          group: "files",
          search: files.value.join(" "),
        });
      } else if (html && !copyPlain) {
        Object.assign(data, html);
      } else if (rtf && !copyPlain) {
        Object.assign(data, rtf);
      } else if (text) {
        const subtype = await getClipboardTextSubtype(text.value);

        Object.assign(data, text, {
          subtype,
        });
      } else if (image) {
        Object.assign(data, image, {
          group: "image",
        });
      }

      const sqlData = cloneDeep(data);

      const { type, value, group, createTime } = data;

      if (type === "image") {
        sqlData.value = await fullName(value);
      }

      if (type === "files") {
        sqlData.value = JSON.stringify(value);
      }

      const [matched] = await selectHistory((qb) => {
        const { type, value } = sqlData;

        return qb.where("type", "=", type).where("value", "=", value);
      });

      const visible = state.group === "all" || state.group === group;

      if (matched) {
        if (!clipboardStore.content.autoSort) return;

        const { id } = matched;

        if (visible) {
          remove(state.list, { id });

          state.list.unshift({ ...data, id });
        }

        return updateHistory(id, { createTime });
      }

      if (visible) {
        state.list.unshift(data);
      }

      insertHistory(sqlData);
    }, options);
  });
};
