/// <reference path="../interfaces/togeojson.d.ts" />
/*!
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {drive_v3} from 'googleapis';
import pLimit from 'p-limit';
import {OAuth2Client} from 'google-auth-library';
import {ErrorReporting} from '@google-cloud/error-reporting';
import {ITable} from '../interfaces/table';
import {ISheet} from '../interfaces/sheet';
import getCsv from './get-csv';
import ExportProgress from './export-progress';
import getArchiveFolder from '../drive/get-archive-folder';
import getFusiontableStyles from '../fusiontables/get-styles';
import getDriveUploadFolder from '../drive/get-upload-folder';
import uploadToDrive from '../drive/upload';
import getArchiveIndexSheet from '../drive/get-archive-index-sheet';
import insertExportRowInIndexSheet from '../drive/insert-export-row-in-index-sheet';
import logFileExportInIndexSheet from '../drive/log-file-export-in-index-sheet';
import addFilePermissions from '../drive/add-file-permissions';
import {IS_LARGE_TRESHOLD} from '../config/config';
import {web as serverCredentials} from '../config/credentials.json';
import {IStyle} from '../interfaces/style';

const errors = new ErrorReporting({
  reportUnhandledRejections: true,
  projectId: serverCredentials.project_id
});

/**
 * Export a table from FusionTables and save it to Drive
 */
interface IDoExportOptions {
  auth: OAuth2Client;
  exportProgress: ExportProgress;
  exportId: string;
  tables: ITable[];
}
export default async function(options: IDoExportOptions): Promise<string> {
  const {auth, exportProgress, exportId, tables} = options;
  const limit = pLimit(1);
  let folderId: string;
  let archiveSheet: ISheet;

  console.info(`• Start export ${exportId} with ${tables.length} tables`);

  try {
    const archiveFolderId = await getArchiveFolder(auth);
    folderId = await getDriveUploadFolder(auth, archiveFolderId);
    archiveSheet = await getArchiveIndexSheet(auth, archiveFolderId);
    await insertExportRowInIndexSheet(auth, archiveSheet, folderId);
  } catch (error) {
    throw error;
  }

  tables.map((table, index) =>
    limit(() =>
      saveTable({
        table,
        auth,
        folderId,
        archiveSheet,
        exportProgress,
        exportId,
        isLast: index === tables.length - 1
      })
    )
  );

  return folderId;
}

/**
 * Save a table from FusionTables to Drive
 */
interface ISaveTableOptions {
  table: ITable;
  auth: OAuth2Client;
  folderId: string;
  archiveSheet: ISheet;
  exportProgress: ExportProgress;
  exportId: string;
  isLast: boolean;
}
async function saveTable(options: ISaveTableOptions): Promise<void> {
  const {
    table,
    auth,
    folderId,
    archiveSheet,
    exportProgress,
    exportId,
    isLast
  } = options;
  let isLarge: boolean = false;
  let hasGeometryData: boolean = false;
  let driveFile: drive_v3.Schema$File | undefined;
  let styles: IStyle[] = [];

  console.info(`• Start export of table ${table.id} from export ${exportId}`);

  try {
    const csv = await getCsv(auth, table);
    isLarge = csv.data.length > IS_LARGE_TRESHOLD;
    hasGeometryData = csv.hasGeometryData || false;
    driveFile = await uploadToDrive(auth, folderId, csv);
    styles = await getFusiontableStyles(auth, table.id);
    await logFileExportInIndexSheet({
      auth,
      sheet: archiveSheet,
      table,
      driveFile,
      styles,
      hasGeometryData
    });
    await addFilePermissions(auth, driveFile.id as string, table.permissions);

    await exportProgress.logTable({
      exportId,
      tableId: table.id,
      status: 'success',
      driveFile,
      styles,
      isLarge,
      hasGeometryData
    });

    console.info(
      `• Successfully finished table ${table.id} from export ${exportId}`
    );

    if (isLast) {
      console.info(`• Finished export ${exportId}`);
    }
  } catch (error) {
    errors.report(error);
    await exportProgress.logTable({
      exportId,
      tableId: table.id,
      status: 'error',
      error: error.message,
      driveFile,
      styles,
      isLarge,
      hasGeometryData
    });

    console.info(
      `• Finished with an error! Table ${table.id} from export ${exportId}`
    );

    if (isLast) {
      console.info(`• Finished export ${exportId}`);
    }
  }
}
