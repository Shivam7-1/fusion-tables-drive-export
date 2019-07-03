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

import express, {Response, Request} from 'express';
import helmet from 'helmet';
import boom from 'boom';
import cookieSession from 'cookie-session';
import {ErrorReporting} from '@google-cloud/error-reporting';
import {getOAuthClient, getAuthUrl} from './lib/auth';
import findFusiontables from './drive/find-fusiontables';
import getFusiontablesByIds from './drive/get-fusiontables-by-ids';
import ExportProgress from './lib/export-progress';
import doExport from './lib/do-export';
import {isString} from 'util';
import {AddressInfo} from 'net';
import {web as serverCredentials} from './config/credentials.json';

const app = express();
const exportProgress = new ExportProgress();
const errors = new ErrorReporting({
  reportUnhandledRejections: true,
  projectId: serverCredentials.project_id
});

app.set('view engine', 'pug');
app.set('views', './server-views');
app.use(express.urlencoded({extended: true}));
app.use(helmet());
app.use(helmet.referrerPolicy({policy: 'same-origin'}));
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      // tslint:disable quotemark
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'www.googletagmanager.com',
        'www.google-analytics.com'
      ],
      imgSrc: ["'self'", 'www.google-analytics.com'],
      styleSrc: ["'self'", 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com']
      // tslint:enable quotemark
    }
  })
);
app.use(express.static('server-static'));

app.use(
  cookieSession({
    name: 'fusiontables',
    keys: [
      'WLTiBCAZtthrUGMUK4Yjx(TBNvisYkHLeT)XGaEU',
      'hzACNQ^TykcjCGBgcPR(UCTtv9pvaogGqJtHFQND'
    ],
    maxAge: 24 * 60 * 60 * 1000
  })
);

app.get('/', (req, res) => {
  const isSignedIn = Boolean(req.session && req.session.tokens);

  if (isSignedIn) {
    return res.redirect(303, '/export');
  }

  res.render('index', {isSignedIn});
});

app.get('/auth', (req, res) => {
  const isSignedIn = Boolean(req.session && req.session.tokens);

  if (isSignedIn) {
    return res.redirect(303, '/export');
  }

  const url = getAuthUrl(req);
  res.redirect(303, url);
});

app.get('/auth/callback', (req, res, next) => {
  if (!req.query.code) {
    return next(boom.badRequest());
  }

  const auth = getOAuthClient(req);
  auth
    .getToken(req.query.code)
    .then(({tokens}) => {
      if (!req.session) {
        req.session = {};
      }

      req.session.tokens = tokens;
      res.redirect(303, '/export');
    })
    .catch(error => next(boom.badImplementation(error)));
});

app.get('/export/:exportId/updates', async (req, res, next) => {
  const tokens = req.session && req.session.tokens;
  const isSignedIn = Boolean(tokens);
  const exportId = req.params.exportId;

  if (!isSignedIn || !exportProgress.isAuthorized(exportId, tokens)) {
    return next(boom.unauthorized());
  }

  try {
    const tables = await exportProgress.getExportTables(exportId);
    const allFinished = tables.every(table => table.status !== 'loading');

    if (allFinished) {
      exportProgress.deleteExport(exportId);
      req.session = undefined;
    }

    res.set('Cache-Control', 'no-store');
    res.json(tables);
  } catch (error) {
    next(boom.badImplementation(error));
  }
});

app.get('/export/:exportId', async (req, res, next) => {
  const tokens = req.session && req.session.tokens;
  const exportId = req.params.exportId;

  if (!tokens || !exportProgress.isAuthorized(exportId, tokens)) {
    return res.redirect(303, '/');
  }

  try {
    const tables = await exportProgress.getExportTables(exportId);
    const exportFolderId = await exportProgress.getExportFolderId(exportId);

    res.set('Cache-Control', 'no-store');
    res.render('export-in-progress', {
      tables,
      isSignedIn: Boolean(tokens),
      exportFolderId,
      exportId
    });
  } catch (error) {
    next(boom.badImplementation(error));
  }
});

app.get('/export', (req, res, next) => {
  const tokens = req.session && req.session.tokens;

  if (!tokens) {
    return res.redirect(303, '/');
  }

  const auth = getOAuthClient(req);
  auth.setCredentials(tokens);
  const {filterByName, pageToken} = req.query;

  findFusiontables(auth, filterByName, pageToken)
    .then(({tables, nextPageToken}) => {
      res.set('Cache-Control', 'no-store');
      res.render('export-select-tables', {
        tables,
        isSignedIn: Boolean(tokens),
        filterByName,
        nextPageToken
      });
    })
    .catch(error => next(boom.badImplementation(error)));
});

app.post('/export', (req, res, next) => {
  const tokens = req.session && req.session.tokens;

  if (!tokens) {
    return res.redirect(303, '/');
  }

  const tableIds = req.body.tableIds || [];
  const auth = getOAuthClient(req);
  auth.setCredentials(tokens);

  getFusiontablesByIds(auth, tableIds)
    .then(async tables => {
      const exportId = await exportProgress.startExport(tokens, tables);
      const exportFolderId = await doExport({
        auth,
        tables,
        exportProgress,
        exportId
      });
      await exportProgress.logExportFolder(exportId, exportFolderId);
      return res.redirect(302, `/export/${exportId}`);
    })
    .catch(error => next(boom.badImplementation(error)));
});

app.get('/clear-exports', (req, res) => {
  if (req.get('X-Appengine-Cron') !== 'true') {
    res.sendStatus(401);
    return;
  }

  exportProgress.clearFinishedExports();
  res.sendStatus(200);
});

app.get('/privacy', (req, res) => {
  res.redirect(301, 'https://policies.google.com/privacy');
});

app.get('/terms', (req, res) => {
  res.redirect(301, 'https://policies.google.com/terms');
});

app.get('/logout', (req, res) => {
  req.session = undefined;
  res.redirect(303, '/');
});

app.use((error: boom, req: Request, res: Response, next: any) => {
  console.log(error.message, error.name);

  errors.report(error);

  if (
    error &&
    (error.message === 'invalid_request' ||
      error.message === 'No refresh token is set.')
  ) {
    return res.redirect(303, '/logout');
  }

  return res
    .status((error.output && error.output.statusCode) || 500)
    .render('error', {error: error.message});
});

app.use((req: Request, res: Response, next: any) => {
  const isSignedIn = Boolean(req.session && req.session.tokens);

  res.status(404).render('404', {isSignedIn});
});

if (module === require.main) {
  const server = app.listen(process.env.PORT || 3000, () => {
    const address = server.address() as string | AddressInfo;
    const port = isString(address) ? address : address.port;
    console.log(`App listening on port ${port}`);
  });
}

module.exports = app;
