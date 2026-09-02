import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface RemotePageSummary {
  id: number;
  path: string;
  title: string;
  updatedAt: string;
}

export interface RemotePage {
  id: number;
  path: string;
  title: string;
  description: string;
  content: string;
  editor: string;
  locale: string;
  isPublished: boolean;
  isPrivate: boolean;
  updatedAt: string;
  tags: string[];
}

export interface PageInput {
  path: string;
  title: string;
  description: string;
  editor: string;
  locale: string;
  isPublished: boolean;
  isPrivate: boolean;
  tags: string[];
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function graphqlRequest<T>(
  baseUrl: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const url = new URL('/graphql', baseUrl);
  const body = JSON.stringify({ query, variables: variables ?? {} });
  const lib = url.protocol === 'https:' ? https : http;

  const responseText: string = await new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  let payload: GraphQLResponse<T>;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Wiki.js API returned a non-JSON response: ${responseText.slice(0, 300)}`
    );
  }

  if (payload.errors?.length) {
    throw new Error(
      'Wiki.js API error: ' + payload.errors.map((e) => e.message).join('; ')
    );
  }
  if (!payload.data) {
    throw new Error('Wiki.js API returned no data.');
  }
  return payload.data;
}

const PAGE_FIELDS = `
  id path title description content editor locale
  isPublished isPrivate updatedAt
  tags { tag }
`;

export async function listPages(
  url: string,
  token: string
): Promise<RemotePageSummary[]> {
  const data = await graphqlRequest<{ pages: { list: RemotePageSummary[] } }>(
    url,
    token,
    'query { pages { list { id path title updatedAt } } }'
  );
  return data.pages.list;
}

export async function getPage(
  url: string,
  token: string,
  id: number
): Promise<RemotePage> {
  const data = await graphqlRequest<{ pages: { single: any } }>(
    url,
    token,
    `query($id: Int!) { pages { single(id: $id) { ${PAGE_FIELDS} } } }`,
    { id }
  );
  const p = data.pages.single;
  return { ...p, tags: (p.tags ?? []).map((t: { tag: string }) => t.tag) };
}

export async function getPageByPath(
  url: string,
  token: string,
  path: string,
  locale: string
): Promise<RemotePage | undefined> {
  const data = await graphqlRequest<{ pages: { singleByPath: any } }>(
    url,
    token,
    `query($path: String!, $locale: String!) { pages { singleByPath(path: $path, locale: $locale) { ${PAGE_FIELDS} } } }`,
    { path, locale }
  );
  const p = data.pages.singleByPath;
  if (!p) return undefined;
  return { ...p, tags: (p.tags ?? []).map((t: { tag: string }) => t.tag) };
}

export async function getPageUpdatedAt(
  url: string,
  token: string,
  id: number
): Promise<string | undefined> {
  const data = await graphqlRequest<{
    pages: { single: { updatedAt: string } | null };
  }>(
    url,
    token,
    'query($id: Int!) { pages { single(id: $id) { updatedAt } } }',
    { id }
  );
  return data.pages.single?.updatedAt;
}

interface MutationResult {
  responseResult: { succeeded: boolean; errorCode: number; message: string };
  page: { id: number; path: string; updatedAt: string };
}

const CREATE_MUTATION = `
mutation($content:String!,$description:String!,$editor:String!,$isPublished:Boolean!,
         $isPrivate:Boolean!,$locale:String!,$path:String!,$tags:[String]!,$title:String!) {
  pages {
    create(content:$content, description:$description, editor:$editor,
           isPublished:$isPublished, isPrivate:$isPrivate, locale:$locale,
           path:$path, tags:$tags, title:$title) {
      responseResult { succeeded errorCode message }
      page { id path updatedAt }
    }
  }
}`;

const UPDATE_MUTATION = `
mutation($id:Int!,$content:String!,$description:String!,$editor:String!,$isPublished:Boolean!,
         $isPrivate:Boolean!,$locale:String!,$path:String!,$tags:[String]!,$title:String!) {
  pages {
    update(id:$id, content:$content, description:$description, editor:$editor,
           isPublished:$isPublished, isPrivate:$isPrivate, locale:$locale,
           path:$path, tags:$tags, title:$title) {
      responseResult { succeeded errorCode message }
      page { id path updatedAt }
    }
  }
}`;

export async function createPage(
  url: string,
  token: string,
  meta: PageInput,
  content: string
): Promise<{ id: number; updatedAt: string }> {
  const data = await graphqlRequest<{ pages: { create: MutationResult } }>(
    url,
    token,
    CREATE_MUTATION,
    {
      ...meta,
      content,
    }
  );
  const result = data.pages.create;
  if (!result.responseResult.succeeded) {
    throw new Error(
      `Create failed for ${meta.path}: ${result.responseResult.message}`
    );
  }
  return result.page;
}

export interface AssetFolder {
  id: number;
  name: string;
  slug: string;
}

export async function listAssetFolders(
  url: string,
  token: string,
  parentFolderId: number
): Promise<AssetFolder[]> {
  const data = await graphqlRequest<{ assets: { folders: AssetFolder[] } }>(
    url,
    token,
    'query($parentFolderId: Int!) { assets { folders(parentFolderId: $parentFolderId) { id name slug } } }',
    { parentFolderId }
  );
  return data.assets.folders;
}

export async function createAssetFolder(
  url: string,
  token: string,
  parentFolderId: number,
  slug: string
): Promise<void> {
  const data = await graphqlRequest<{
    assets: {
      createFolder: { responseResult: { succeeded: boolean; message: string } };
    };
  }>(
    url,
    token,
    'mutation($parentFolderId: Int!, $slug: String!) { assets { createFolder(parentFolderId: $parentFolderId, slug: $slug) { responseResult { succeeded message } } } }',
    { parentFolderId, slug }
  );
  const result = data.assets.createFolder;
  if (!result.responseResult.succeeded) {
    throw new Error(
      `Create folder failed for "${slug}": ${result.responseResult.message}`
    );
  }
}

export interface AssetSummary {
  id: number;
  filename: string;
}

export async function listAssets(
  url: string,
  token: string,
  folderId: number
): Promise<AssetSummary[]> {
  const data = await graphqlRequest<{ assets: { list: AssetSummary[] } }>(
    url,
    token,
    'query($folderId: Int!) { assets { list(folderId: $folderId, kind: ALL) { id filename } } }',
    { folderId }
  );
  return data.assets.list;
}

// Wiki.js's asset upload isn't a GraphQL mutation (it's a plain multipart
// route, since GraphQL isn't well suited to binary bodies): POST /u with a
// "mediaUpload" text part carrying {folderId} JSON and a "mediaUpload" file
// part carrying the bytes. A successful response is plain text "ok".
export async function uploadAsset(
  baseUrl: string,
  token: string,
  folderId: number,
  filename: string,
  fileContent: Buffer,
  mime: string
): Promise<void> {
  const boundary = `----wikijsSyncBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const textPart = (s: string) => Buffer.from(s, 'utf8');

  const body = Buffer.concat([
    textPart(`--${boundary}\r\n`),
    textPart('Content-Disposition: form-data; name="mediaUpload"\r\n\r\n'),
    textPart(`${JSON.stringify({ folderId })}\r\n`),

    textPart(`--${boundary}\r\n`),
    textPart(
      `Content-Disposition: form-data; name="mediaUpload"; filename="${filename}"\r\n`
    ),
    textPart(`Content-Type: ${mime}\r\n\r\n`),
    fileContent,
    textPart(`\r\n--${boundary}--\r\n`),
  ]);

  const url = new URL('/u', baseUrl);
  const lib = url.protocol === 'https:' ? https : http;

  const { status, text } = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const req = lib.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: data })
          );
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    }
  );

  if (status !== 200 || text.trim().toLowerCase() !== 'ok') {
    throw new Error(
      `Asset upload failed (HTTP ${status}): ${text.slice(0, 300)}`
    );
  }
}

export async function updatePage(
  url: string,
  token: string,
  id: number,
  meta: PageInput,
  content: string
): Promise<{ id: number; updatedAt: string }> {
  const data = await graphqlRequest<{ pages: { update: MutationResult } }>(
    url,
    token,
    UPDATE_MUTATION,
    // `id` last: callers pass a PageMeta whose own `id` field (often undefined
    // on a page being adopted by path) would otherwise clobber the real id and
    // send `$id: null` — Wiki.js then rejects the whole mutation.
    {
      ...meta,
      content,
      id,
    }
  );
  const result = data.pages.update;
  if (!result.responseResult.succeeded) {
    throw new Error(
      `Update failed for ${meta.path} (id ${id}): ${result.responseResult.message}`
    );
  }
  return result.page;
}
