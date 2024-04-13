import { Intent } from '@blueprintjs/core';
import { FSModule } from 'browserfs/dist/node/core/FS';
import { GoogleOAuthProvider, SuccessTokenResponse } from 'google-oauth-gsi';
import { Chapter, Variant } from 'js-slang/dist/types';
import { SagaIterator } from 'redux-saga';
import { call, put, select } from 'redux-saga/effects';
import { WORKSPACE_BASE_PATHS } from 'src/pages/fileSystem/createInBrowserFileSystem';

import {
  PERSISTENCE_CREATE_FILE,
  PERSISTENCE_CREATE_FOLDER,
  PERSISTENCE_DELETE_FILE,
  PERSISTENCE_DELETE_FOLDER,
  PERSISTENCE_INITIALISE,
  PERSISTENCE_OPEN_PICKER,
  PERSISTENCE_RENAME_FILE,
  PERSISTENCE_RENAME_FOLDER,
  PERSISTENCE_SAVE_ALL,
  PERSISTENCE_SAVE_FILE,
  PERSISTENCE_SAVE_FILE_AS,
  PersistenceFile
} from '../../features/persistence/PersistenceTypes';
import { store } from '../../pages/createStore';
import { OverallState } from '../application/ApplicationTypes';
import { ExternalLibraryName } from '../application/types/ExternalTypes';
import { LOGIN_GOOGLE, LOGOUT_GOOGLE } from '../application/types/SessionTypes';
import {
  retrieveFilesInWorkspaceAsRecord,
  rmFilesInDirRecursively,
  writeFileRecursively
} from '../fileSystem/FileSystemUtils';
import { actions } from '../utils/ActionsHelper';
import Constants from '../utils/Constants';
import {
  showSimpleConfirmDialog,
  showSimpleErrorDialog,
  showSimplePromptDialog
} from '../utils/DialogHelper';
import {
  dismiss,
  showMessage,
  showSuccessMessage,
  showWarningMessage
} from '../utils/notifications/NotificationsHelper';
import { filePathRegex } from '../utils/PersistenceHelper';
import { AsyncReturnType } from '../utils/TypeHelper';
import { EditorTabState } from '../workspace/WorkspaceTypes';
import { safeTakeEvery as takeEvery, safeTakeLatest as takeLatest } from './SafeEffects';

const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'];
const SCOPES =
  'profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive';
const UPLOAD_PATH = 'https://www.googleapis.com/upload/drive/v3/files';
const USER_INFO_PATH = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Special ID value for the Google Drive API.
const ROOT_ID = 'root';

const MIME_SOURCE = 'text/plain';
const MIME_FOLDER = 'application/vnd.google-apps.folder';

// GIS Token Client
let googleProvider: GoogleOAuthProvider;
// Login function
function* googleLogin() {
  try {
    const tokenResp: SuccessTokenResponse = yield new Promise<SuccessTokenResponse>(
      (resolve, reject) => {
        googleProvider.useGoogleLogin({
          flow: 'implicit',
          onSuccess: resolve,
          onError: reject,
          scope: SCOPES
        })();
      }
    );
    yield call(handleUserChanged, tokenResp.access_token);
  } catch (ex) {
    console.error(ex);
  }
}

export function* persistenceSaga(): SagaIterator {
  yield takeLatest(LOGOUT_GOOGLE, function* (): any {
    yield put(actions.playgroundUpdatePersistenceFile(undefined));
    yield call(ensureInitialised);
    yield call(gapi.client.setToken, null);
    yield put(actions.removeGoogleUserAndAccessToken());
  });

  yield takeLatest(LOGIN_GOOGLE, function* (): any {
    yield call(ensureInitialised);
    yield call(googleLogin);
  });

  yield takeEvery(PERSISTENCE_INITIALISE, function* (): any {
    yield call(ensureInitialised);
    // check for stored token
    const accessToken = yield select((state: OverallState) => state.session.googleAccessToken);
    if (accessToken) {
      yield call(gapi.client.setToken, { access_token: accessToken });
      yield call(handleUserChanged, accessToken);
    }
  });

  yield takeLatest(PERSISTENCE_OPEN_PICKER, function* (): any {
    let toastKey: string | undefined;
    try {
      yield call(ensureInitialisedAndAuthorised);
      const { id, name, mimeType, picked, parentId } = yield call(
        pickFile,
        'Pick a file/folder to open',
        {
          pickFolders: true
        }
      ); // id, name, picked gotten here

      yield call(console.log, parentId);
      if (!picked) {
        return;
      }

      const confirmOpen: boolean = yield call(showSimpleConfirmDialog, {
        title: 'Opening from Google Drive',
        contents: (
          <p>
            Opening <strong>{name}</strong> will overwrite the current contents of your workspace.
            Are you sure?
          </p>
        ),
        positiveLabel: 'Open',
        negativeLabel: 'Cancel'
      });
      if (!confirmOpen) {
        return;
      }

      yield call(store.dispatch, actions.disableFileSystemContextMenus());

      // Note: for mimeType, text/plain -> file, application/vnd.google-apps.folder -> folder

      if (mimeType === MIME_FOLDER) {
        // handle folders
        toastKey = yield call(showMessage, {
          message: 'Opening folder...',
          timeout: 0,
          intent: Intent.PRIMARY
        });

        const fileList = yield call(getFilesOfFolder, id, name); // this needed the extra scope mimetypes to have every file
        // TODO: add type for each resp?
        yield call(console.log, 'fileList', fileList);

        const fileSystem: FSModule | null = yield select(
          (state: OverallState) => state.fileSystem.inBrowserFileSystem
        );
        // If the file system is not initialised, do nothing.
        if (fileSystem === null) {
          yield call(console.log, 'no filesystem!');
          return;
        }

        // Begin

        // rm everything TODO replace everything hardcoded with playground?
        yield call(rmFilesInDirRecursively, fileSystem, '/playground');

        // clear all persistence files
        yield call(store.dispatch, actions.deleteAllPersistenceFiles());

        // add tlrf
        yield put(
          actions.addPersistenceFile({
            id,
            parentId,
            name,
            path: '/playground/' + name,
            isFolder: true
          })
        );

        for (const currFile of fileList) {
          if (currFile.isFolder === true) {
            yield call(console.log, 'not file ', currFile);
            yield put(
              actions.addPersistenceFile({
                id: currFile.id,
                parentId: currFile.parentId,
                name: currFile.name,
                path: '/playground' + currFile.path,
                isFolder: true
              })
            );
            continue;
          }
          yield put(
            actions.addPersistenceFile({
              id: currFile.id,
              parentId: currFile.parentId,
              name: currFile.name,
              path: '/playground' + currFile.path,
              lastSaved: new Date()
            })
          );
          const contents = yield call([gapi.client.drive.files, 'get'], {
            fileId: currFile.id,
            alt: 'media'
          });
          console.log(currFile.path);
          console.log(contents.body === '');
          yield call(
            writeFileRecursively,
            fileSystem,
            '/playground' + currFile.path,
            contents.body
          );
          yield call(showSuccessMessage, `Loaded file ${currFile.path}.`, 1000);
        }

        // set source to chapter 4 TODO is there a better way of handling this
        yield put(
          actions.chapterSelect(parseInt('4', 10) as Chapter, Variant.DEFAULT, 'playground')
        );
        // open folder mode TODO enable button
        //yield call(store.dispatch, actions.setFolderMode("playground", true));
        yield call(store.dispatch, actions.enableFileSystemContextMenus());

        // DDDDDDDDDDDDDDDebug
        const test = yield select((state: OverallState) => state.fileSystem.persistenceFileArray);
        yield call(console.log, test);

        // refresh needed
        yield call(
          store.dispatch,
          actions.removeEditorTabsForDirectory('playground', WORKSPACE_BASE_PATHS['playground'])
        ); // TODO hardcoded
        // TODO find a file to open instead of deleting all active tabs?
        // TODO without modifying WorkspaceReducer in one function this would cause errors - called by onChange of Playground.tsx?
        // TODO change behaviour of WorkspaceReducer to not create program.js every time folder mode changes with 0 tabs existing?
        yield call(store.dispatch, actions.updateRefreshFileViewKey());

        yield call(showSuccessMessage, `Loaded folder ${name}.`, 1000);

        // TODO does not update playground on loading folder
        yield call(console.log, 'ahfdaskjhfkjsadf', parentId);
        yield put(
          actions.playgroundUpdatePersistenceFolder({ id, name, parentId, lastSaved: new Date() })
        );

        return;
      }

      toastKey = yield call(showMessage, {
        message: 'Opening file...',
        timeout: 0,
        intent: Intent.PRIMARY
      });

      const { result: meta } = yield call([gapi.client.drive.files, 'get'], {
        // get fileid here using gapi.client.drive.files
        fileId: id,
        fields: 'appProperties'
      });
      const contents = yield call([gapi.client.drive.files, 'get'], { fileId: id, alt: 'media' });
      const activeEditorTabIndex: number | null = yield select(
        (state: OverallState) => state.workspaces.playground.activeEditorTabIndex
      );
      if (activeEditorTabIndex === null) {
        throw new Error('No active editor tab found.');
      }
      yield put(actions.updateEditorValue('playground', activeEditorTabIndex, contents.body)); // CONTENTS OF SELECTED FILE LOADED HERE
      yield put(actions.playgroundUpdatePersistenceFile({ id, name, lastSaved: new Date() }));
      if (meta && meta.appProperties) {
        yield put(
          actions.chapterSelect(
            parseInt(meta.appProperties.chapter || '4', 10) as Chapter,
            meta.appProperties.variant || Variant.DEFAULT,
            'playground'
          )
        );
        yield put(
          actions.externalLibrarySelect(
            Object.values(ExternalLibraryName).find(v => v === meta.appProperties.external) ||
              ExternalLibraryName.NONE,
            'playground'
          )
        );
      }

      yield call(showSuccessMessage, `Loaded ${name}.`, 1000);
    } catch (ex) {
      console.error(ex);
      yield call(showWarningMessage, `Error while opening file.`, 1000);
    } finally {
      if (toastKey) {
        dismiss(toastKey);
      }
    }
  });

  yield takeLatest(PERSISTENCE_SAVE_FILE_AS, function* (): any {
    // TODO wrap first part in try catch finally block
    let toastKey: string | undefined;
    const persistenceFileArray: PersistenceFile[] = yield select(
      (state: OverallState) => state.fileSystem.persistenceFileArray
    );
    const [currPersistenceFile] = yield select((state: OverallState) => [
      state.playground.persistenceFile
    ]);
    yield call(console.log, 'currpersfile ', currPersistenceFile);
    try {
      yield call(ensureInitialisedAndAuthorised);

      const [activeEditorTabIndex, editorTabs, chapter, variant, external] = yield select(
        (state: OverallState) => [
          state.workspaces.playground.activeEditorTabIndex,
          state.workspaces.playground.editorTabs,
          state.workspaces.playground.context.chapter,
          state.workspaces.playground.context.variant,
          state.workspaces.playground.externalLibrary
        ]
      );

      if (activeEditorTabIndex === null) {
        throw new Error('No active editor tab found.');
      }
      const code = editorTabs[activeEditorTabIndex].value;

      const pickedDir: PickFileResult = yield call(
        pickFile,
        'Pick a folder, or cancel to pick the root folder',
        {
          pickFolders: true,
          showFolders: true,
          showFiles: false
        }
      );

      const saveToDir: PersistenceFile = pickedDir.picked // TODO is there a better way?
        ? { ...pickedDir }
        : { id: ROOT_ID, name: 'My Drive' };

      const pickedFile: PickFileResult = yield call(
        pickFile,
        `Saving to ${saveToDir.name}; pick a file to overwrite, or cancel to save as a new file`,
        {
          pickFolders: false,
          showFolders: false,
          showFiles: true,
          rootFolder: saveToDir.id
        }
      );

      if (pickedFile.picked) {
        const reallyOverwrite: boolean = yield call(showSimpleConfirmDialog, {
          title: 'Saving to Google Drive',
          contents: (
            <span>
              Really overwrite <strong>{pickedFile.name}</strong>?
            </span>
          )
        });
        if (!reallyOverwrite) {
          return;
        }

        yield call(store.dispatch, actions.disableFileSystemContextMenus());
        // Case: Picked a file to overwrite
        if (currPersistenceFile && currPersistenceFile.isFolder) {
          yield call(console.log, 'folder opened, handling save_as differently! overwriting file');
          // First case: Chosen location is within TLRF - so need to call methods to update PersistenceFileArray
          // Other case: Chosen location is outside TLRF - don't care

          const [chapter, variant, external] = yield select((state: OverallState) => [
            state.workspaces.playground.context.chapter,
            state.workspaces.playground.context.variant,
            state.workspaces.playground.externalLibrary
          ]);
          const config: IPlaygroundConfig = {
            chapter,
            variant,
            external
          };

          yield call(
            console.log,
            'curr pers file ',
            currPersistenceFile,
            ' pickedDir ',
            pickedDir,
            ' pickedFile ',
            pickedFile
          );
          const localFileTarget = persistenceFileArray.find(e => e.id === pickedFile.id);
          if (localFileTarget) {
            toastKey = yield call(showMessage, {
              message: `Saving as ${localFileTarget.name}...`,
              timeout: 0,
              intent: Intent.PRIMARY
            });
            // identical to just saving a file locally
            const fileSystem: FSModule | null = yield select(
              (state: OverallState) => state.fileSystem.inBrowserFileSystem
            );
            if (fileSystem === null) {
              yield call(console.log, 'no filesystem!');
              throw new Error('No filesystem');
            }

            yield call(
              updateFile,
              localFileTarget.id,
              localFileTarget.name,
              MIME_SOURCE,
              code,
              config
            );

            yield put(
              actions.addPersistenceFile({
                ...localFileTarget,
                lastSaved: new Date(),
                lastEdit: undefined
              })
            );
            yield call(writeFileRecursively, fileSystem, localFileTarget.path!, code);
            yield call(store.dispatch, actions.updateRefreshFileViewKey());
          } else {
            yield call(updateFile, pickedFile.id, pickedFile.name, MIME_SOURCE, code, config);
          }
          yield call(
            showSuccessMessage,
            `${pickedFile.name} successfully saved to Google Drive.`,
            1000
          );
          return;
        }
        yield put(actions.playgroundUpdatePersistenceFile(pickedFile));
        yield put(actions.persistenceSaveFile(pickedFile));
      } else {
        const response: AsyncReturnType<typeof showSimplePromptDialog> = yield call(
          showSimplePromptDialog,
          {
            title: 'Saving to Google Drive',
            contents: (
              <>
                <p>
                  Saving to folder <strong>{saveToDir.name}</strong>.
                </p>
                <p>Save as name?</p>
              </>
            ),
            positiveLabel: 'Save as new file',
            negativeLabel: 'Cancel',
            props: {
              validationFunction: value => !!value
            }
          }
        );

        if (!response.buttonResponse) {
          return;
        }

        // yield call(store.dispatch, actions.disableFileSystemContextMenus());

        const config: IPlaygroundConfig = {
          chapter,
          variant,
          external
        };

        toastKey = yield call(showMessage, {
          message: `Saving as ${response.value}...`,
          timeout: 0,
          intent: Intent.PRIMARY
        });

        const newFile: PersistenceFile = yield call(
          createFile,
          response.value,
          saveToDir.id,
          MIME_SOURCE,
          code,
          config
        );

        //Case: Chose to save as a new file
        if (currPersistenceFile && currPersistenceFile.isFolder) {
          yield call(
            console.log,
            'folder opened, handling save_as differently! saving as new file'
          );
          // First case: Chosen location is within TLRF - so need to call methods to update PersistenceFileArray
          // Other case: Chosen location is outside TLRF - don't care

          yield call(
            console.log,
            'curr persFileArr ',
            persistenceFileArray,
            ' pickedDir ',
            pickedDir,
            ' pickedFile ',
            pickedFile,
            ' saveToDir ',
            saveToDir
          );
          let needToUpdateLocal = false;
          let localFolderTarget: PersistenceFile;
          for (let i = 0; i < persistenceFileArray.length; i++) {
            if (persistenceFileArray[i].isFolder && persistenceFileArray[i].id === saveToDir.id) {
              needToUpdateLocal = true;
              localFolderTarget = persistenceFileArray[i];
              break;
            }
          }

          if (needToUpdateLocal) {
            const fileSystem: FSModule | null = yield select(
              (state: OverallState) => state.fileSystem.inBrowserFileSystem
            );
            if (fileSystem === null) {
              yield call(console.log, 'no filesystem!');
              throw new Error('No filesystem');
            }
            const newPath = localFolderTarget!.path + '/' + response.value;
            yield put(
              actions.addPersistenceFile({ ...newFile, lastSaved: new Date(), path: newPath })
            );
            yield call(writeFileRecursively, fileSystem, newPath, code);
            yield call(store.dispatch, actions.updateRefreshFileViewKey());
          }

          yield call(
            showSuccessMessage,
            `${response.value} successfully saved to Google Drive.`,
            1000
          );
          return;
        }

        yield put(actions.playgroundUpdatePersistenceFile({ ...newFile, lastSaved: new Date() }));
        yield call(
          showSuccessMessage,
          `${response.value} successfully saved to Google Drive.`,
          1000
        );
      }
    } catch (ex) {
      console.error(ex);
      yield call(showWarningMessage, `Error while saving file.`, 1000);
    } finally {
      if (toastKey) {
        dismiss(toastKey);
      }
      yield call(store.dispatch, actions.enableFileSystemContextMenus());
    }
  });

  yield takeEvery(PERSISTENCE_SAVE_ALL, function* () {
    let toastKey: string | undefined;

    try {
      const [currFolderObject] = yield select((state: OverallState) => [
        state.playground.persistenceFile
      ]);

      const fileSystem: FSModule | null = yield select(
        (state: OverallState) => state.fileSystem.inBrowserFileSystem
      );

      // If the file system is not initialised, do nothing.
      if (fileSystem === null) {
        yield call(console.log, 'no filesystem!'); // TODO change to throw new Error
        return;
      }

      const currFiles: Record<string, string> = yield call(
        retrieveFilesInWorkspaceAsRecord,
        'playground',
        fileSystem
      );
      yield call(console.log, 'currfiles', currFiles);

      yield call(console.log, 'there is a filesystem');

      const [chapter, variant, external] = yield select((state: OverallState) => [
        state.workspaces.playground.context.chapter,
        state.workspaces.playground.context.variant,
        state.workspaces.playground.externalLibrary
      ]);
      const config: IPlaygroundConfig = {
        chapter,
        variant,
        external
      };

      if (!currFolderObject || !(currFolderObject as PersistenceFile).isFolder) {
        // Check if there is only a single top level folder
        const testPaths: Set<string> = new Set();
        Object.keys(currFiles).forEach(e => {
          const regexResult = filePathRegex.exec(e)!;
          testPaths.add(regexResult![1].slice('/playground/'.length, -1).split('/')[0]); //TODO hardcoded playground
        });
        if (testPaths.size !== 1) {
          yield call(showSimpleErrorDialog, {
            title: 'Unable to Save All',
            contents: (
              <p>There must be exactly one top level folder present in order to use Save All.</p>
            ),
            label: 'OK'
          });
          return;
        }

        // Now, perform old save all

        // Ask user to confirm location
        const pickedDir: PickFileResult = yield call(
          pickFile,
          'Pick a folder, or cancel to pick the root folder',
          {
            pickFolders: true,
            showFolders: true,
            showFiles: false
          }
        );

        const saveToDir: PersistenceFile = pickedDir.picked // TODO is there a better way?
          ? { ...pickedDir }
          : { id: ROOT_ID, name: 'My Drive' };
        const topLevelFolderName = testPaths.values().next().value;
        let topLevelFolderId: string = yield call(
          getIdOfFileOrFolder,
          saveToDir.id,
          topLevelFolderName
        );

        if (topLevelFolderId !== '') {
          // File already exists
          const reallyOverwrite: boolean = yield call(showSimpleConfirmDialog, {
            title: 'Saving to Google Drive',
            contents: (
              <span>
                Overwrite <strong>{topLevelFolderName}</strong> inside{' '}
                <strong>{saveToDir.name}</strong>? No deletions will be made remotely, only content
                updates, but new remote files may be created.
              </span>
            )
          });
          if (!reallyOverwrite) {
            return;
          }
        } else {
          // Create new folder
          const reallyCreate: boolean = yield call(showSimpleConfirmDialog, {
            title: 'Saving to Google Drive',
            contents: (
              <span>
                Create <strong>{topLevelFolderName}</strong> inside{' '}
                <strong>{saveToDir.name}</strong>?
              </span>
            )
          });
          if (!reallyCreate) {
            return;
          }
          topLevelFolderId = yield call(createFolderAndReturnId, saveToDir.id, topLevelFolderName);
        }
        toastKey = yield call(showMessage, {
          message: `Saving ${topLevelFolderName}...`,
          timeout: 0,
          intent: Intent.PRIMARY
        });
        // it is time
        yield call(store.dispatch, actions.disableFileSystemContextMenus());

        interface FolderIdBundle {
          id: string;
          parentId: string;
        }

        for (const currFullFilePath of Object.keys(currFiles)) {
          const currFileContent = currFiles[currFullFilePath];
          const regexResult = filePathRegex.exec(currFullFilePath)!;
          const currFileName = regexResult[2] + regexResult[3];
          const currFileParentFolders: string[] = regexResult[1]
            .slice(('/playground/' + topLevelFolderName + '/').length, -1)
            .split('/');

          const gcfirResult: FolderIdBundle = yield call(
            getContainingFolderIdRecursively,
            currFileParentFolders,
            topLevelFolderId
          ); // TODO can be optimized by checking persistenceFileArray
          const currFileParentFolderId = gcfirResult.id;
          let currFileId: string = yield call(
            getIdOfFileOrFolder,
            currFileParentFolderId,
            currFileName
          );

          if (currFileId === '') {
            // file does not exist, create file
            yield call(console.log, 'creating ', currFileName);
            const res: PersistenceFile = yield call(
              createFile,
              currFileName,
              currFileParentFolderId,
              MIME_SOURCE,
              currFileContent,
              config
            );
            currFileId = res.id;
          }

          yield call(
            console.log,
            'name',
            currFileName,
            'content',
            currFileContent,
            'parent folder id',
            currFileParentFolderId
          );

          const currPersistenceFile: PersistenceFile = {
            name: currFileName,
            id: currFileId,
            parentId: currFileParentFolderId,
            lastSaved: new Date(),
            path: currFullFilePath
          };
          yield put(actions.addPersistenceFile(currPersistenceFile));

          yield call(console.log, 'updating ', currFileName, ' id: ', currFileId);
          yield call(updateFile, currFileId, currFileName, MIME_SOURCE, currFileContent, config);

          let currParentFolderName = currFileParentFolders[currFileParentFolders.length - 1];
          if (currParentFolderName !== '') currParentFolderName = topLevelFolderName;
          const parentPersistenceFile: PersistenceFile = {
            name: currParentFolderName,
            id: currFileParentFolderId,
            path: regexResult[1].slice(0, -1),
            parentId: gcfirResult.parentId,
            isFolder: true
          };
          yield put(actions.addPersistenceFile(parentPersistenceFile));

          yield call(
            showSuccessMessage,
            `${currFileName} successfully saved to Google Drive.`,
            1000
          );
          yield call(store.dispatch, actions.updateRefreshFileViewKey());
        }

        yield put(
          actions.playgroundUpdatePersistenceFolder({
            id: topLevelFolderId,
            name: topLevelFolderName,
            parentId: saveToDir.id,
            lastSaved: new Date()
          })
        );

        yield call(store.dispatch, actions.enableFileSystemContextMenus());
        yield call(store.dispatch, actions.updateRefreshFileViewKey());

        yield call(
          showSuccessMessage,
          `${topLevelFolderName} successfully saved to Google Drive.`,
          1000
        );
        return;
      }

      // From here onwards, code assumes every file is contained in PersistenceFileArray
      // Instant sync for renaming/deleting/creating files/folders ensures that is the case if folder is opened
      // New files will not be created from here onwards - every operation is an update operation

      toastKey = yield call(showMessage, {
        message: `Saving ${currFolderObject.name}...`,
        timeout: 0,
        intent: Intent.PRIMARY
      });

      console.log('currFolderObj', currFolderObject);
      const persistenceFileArray: PersistenceFile[] = yield select(
        (state: OverallState) => state.fileSystem.persistenceFileArray
      );
      for (const currFullFilePath of Object.keys(currFiles)) {
        const currFileContent = currFiles[currFullFilePath];
        const regexResult = filePathRegex.exec(currFullFilePath)!;
        const currFileName = regexResult[2] + regexResult[3];
        //const currFileParentFolders: string[] = regexResult[1].slice(
        //  ("/playground/" + currFolderObject.name + "/").length, -1)
        //  .split("/");

        // /fold1/ becomes ["fold1"]
        // /fold1/fold2/ becomes ["fold1", "fold2"]
        // If in top level folder, becomes [""]

        const currPersistenceFile = persistenceFileArray.find(e => e.path === currFullFilePath);
        if (currPersistenceFile === undefined) {
          throw new Error('this file is not in persistenceFileArray: ' + currFullFilePath);
        }

        if (!currPersistenceFile.id || !currPersistenceFile.parentId) {
          // get folder
          throw new Error('this file does not have id/parentId: ' + currFullFilePath);
        }

        const currFileId = currPersistenceFile.id!;
        const currFileParentFolderId = currPersistenceFile.parentId!;

        //const currFileParentFolderId: string = yield call(getContainingFolderIdRecursively, currFileParentFolders,
        //  currFolderObject.id);

        yield call(
          console.log,
          'name',
          currFileName,
          'content',
          currFileContent,
          'parent folder id',
          currFileParentFolderId
        );

        //const currFileId: string = yield call(getFileFromFolder, currFileParentFolderId, currFileName);

        //if (currFileId === "") {
        // file does not exist, create file
        // TODO: should never come here
        //yield call(console.log, "creating ", currFileName);
        //yield call(createFile, currFileName, currFileParentFolderId, MIME_SOURCE, currFileContent, config);

        yield call(console.log, 'updating ', currFileName, ' id: ', currFileId);
        yield call(updateFile, currFileId, currFileName, MIME_SOURCE, currFileContent, config);

        currPersistenceFile.lastSaved = new Date();
        yield put(actions.addPersistenceFile(currPersistenceFile));

        yield call(showSuccessMessage, `${currFileName} successfully saved to Google Drive.`, 1000);

        // TODO: create getFileIdRecursively, that uses currFileParentFolderId
        //         to query GDrive api to get a particular file's GDrive id OR modify reading func to save each obj's id somewhere
        //       Then use updateFile like in persistence_save_file to update files that exist
        //         on GDrive, or createFile if the file doesn't exist
      }

      yield put(
        actions.playgroundUpdatePersistenceFolder({
          id: currFolderObject.id,
          name: currFolderObject.name,
          parentId: currFolderObject.parentId,
          lastSaved: new Date()
        })
      );
      yield call(store.dispatch, actions.updateRefreshFileViewKey());
      yield call(
        showSuccessMessage,
        `${currFolderObject.name} successfully saved to Google Drive.`,
        1000
      );
    } catch (ex) {
      console.error(ex);
      yield call(showWarningMessage, `Error while performing Save All.`, 1000);
    } finally {
      if (toastKey) {
        dismiss(toastKey);
      }
      yield call(store.dispatch, actions.enableFileSystemContextMenus());
      yield call(store.dispatch, actions.updateRefreshFileViewKey());
    }
  });

  yield takeEvery(
    PERSISTENCE_SAVE_FILE,
    function* ({ payload: { id, name } }: ReturnType<typeof actions.persistenceSaveFile>) {
      yield call(store.dispatch, actions.disableFileSystemContextMenus());
      let toastKey: string | undefined;

      const [currFolderObject] = yield select(
        // TODO resolve type here?
        (state: OverallState) => [state.playground.persistenceFile]
      );

      yield call(ensureInitialisedAndAuthorised);

      const [activeEditorTabIndex, editorTabs, chapter, variant, external] = yield select(
        (state: OverallState) => [
          state.workspaces.playground.activeEditorTabIndex,
          state.workspaces.playground.editorTabs,
          state.workspaces.playground.context.chapter,
          state.workspaces.playground.context.variant,
          state.workspaces.playground.externalLibrary
        ]
      );

      try {
        if (activeEditorTabIndex === null) {
          throw new Error('No active editor tab found.');
        }
        const code = editorTabs[activeEditorTabIndex].value;

        const config: IPlaygroundConfig = {
          chapter,
          variant,
          external
        };
        if ((currFolderObject as PersistenceFile).isFolder) {
          yield call(console.log, 'folder opened! updating pers specially');
          const persistenceFileArray: PersistenceFile[] = yield select(
            (state: OverallState) => state.fileSystem.persistenceFileArray
          );
          const currPersistenceFile = persistenceFileArray.find(
            e => e.path === (editorTabs[activeEditorTabIndex] as EditorTabState).filePath
          );
          if (!currPersistenceFile) {
            throw new Error('Persistence file not found');
          }
          toastKey = yield call(showMessage, {
            message: `Saving as ${currPersistenceFile.name}...`,
            timeout: 0,
            intent: Intent.PRIMARY
          });
          yield call(
            updateFile,
            currPersistenceFile.id,
            currPersistenceFile.name,
            MIME_SOURCE,
            code,
            config
          );
          currPersistenceFile.lastSaved = new Date();
          yield put(actions.addPersistenceFile(currPersistenceFile));
          yield call(store.dispatch, actions.updateRefreshFileViewKey());
          yield call(
            showSuccessMessage,
            `${currPersistenceFile.name} successfully saved to Google Drive.`,
            1000
          );
          return;
        }

        toastKey = yield call(showMessage, {
          message: `Saving as ${name}...`,
          timeout: 0,
          intent: Intent.PRIMARY
        });

        yield call(updateFile, id, name, MIME_SOURCE, code, config);
        yield put(actions.playgroundUpdatePersistenceFile({ id, name, lastSaved: new Date() }));
        yield call(showSuccessMessage, `${name} successfully saved to Google Drive.`, 1000);
      } catch (ex) {
        console.error(ex);
        yield call(showWarningMessage, `Error while saving file.`, 1000);
      } finally {
        if (toastKey) {
          dismiss(toastKey);
        }
        yield call(store.dispatch, actions.enableFileSystemContextMenus());
      }
    }
  );

  yield takeEvery(
    PERSISTENCE_CREATE_FILE,
    function* ({ payload }: ReturnType<typeof actions.persistenceCreateFile>) {
      yield call(store.dispatch, actions.disableFileSystemContextMenus());

      try {
        const newFilePath = payload;
        yield call(console.log, 'create file ', newFilePath);

        // look for parent folder persistenceFile TODO modify action so name is supplied?
        const regexResult = filePathRegex.exec(newFilePath)!;
        const parentFolderPath = regexResult ? regexResult[1].slice(0, -1) : undefined;
        if (!parentFolderPath) {
          throw new Error('Parent folder path not found');
        }
        const newFileName = regexResult![2] + regexResult![3];
        yield call(console.log, regexResult, 'regexresult!!!!!!!!!!!!!!!!!');
        const persistenceFileArray: PersistenceFile[] = yield select(
          (state: OverallState) => state.fileSystem.persistenceFileArray
        );
        const parentFolderPersistenceFile = persistenceFileArray.find(
          e => e.path === parentFolderPath
        );
        if (!parentFolderPersistenceFile) {
          yield call(console.log, 'parent pers file missing');
          return;
        }

        yield call(
          console.log,
          'parent found ',
          parentFolderPersistenceFile,
          ' for file ',
          newFilePath
        );

        // create file
        const parentFolderId = parentFolderPersistenceFile.id;
        const [chapter, variant, external] = yield select((state: OverallState) => [
          state.workspaces.playground.context.chapter,
          state.workspaces.playground.context.variant,
          state.workspaces.playground.externalLibrary
        ]);
        const config: IPlaygroundConfig = {
          chapter,
          variant,
          external
        };
        const newFilePersistenceFile: PersistenceFile = yield call(
          createFile,
          newFileName,
          parentFolderId,
          MIME_SOURCE,
          '',
          config
        );
        yield put(
          actions.addPersistenceFile({
            ...newFilePersistenceFile,
            lastSaved: new Date(),
            path: newFilePath
          })
        );
        yield call(store.dispatch, actions.updateRefreshFileViewKey());
        yield call(showSuccessMessage, `${newFileName} successfully saved to Google Drive.`, 1000);
      } catch (ex) {
        console.error(ex);
        yield call(showWarningMessage, `Error while creating file.`, 1000);
      } finally {
        yield call(store.dispatch, actions.enableFileSystemContextMenus());
      }
    }
  );

  yield takeEvery(
    PERSISTENCE_CREATE_FOLDER,
    function* ({ payload }: ReturnType<typeof actions.persistenceCreateFolder>) {
      yield call(store.dispatch, actions.disableFileSystemContextMenus());

      try {
        const newFolderPath = payload;
        yield call(console.log, 'create folder ', newFolderPath);

        // const persistenceFileArray: PersistenceFile[] = yield select((state: OverallState) => state.fileSystem.persistenceFileArray);

        // look for parent folder persistenceFile TODO modify action so name is supplied?
        const regexResult = filePathRegex.exec(newFolderPath);
        const parentFolderPath = regexResult ? regexResult[1].slice(0, -1) : undefined;
        if (!parentFolderPath) {
          throw new Error('parent missing');
        }
        const newFolderName = regexResult![2];
        const persistenceFileArray: PersistenceFile[] = yield select(
          (state: OverallState) => state.fileSystem.persistenceFileArray
        );
        const parentFolderPersistenceFile = persistenceFileArray.find(
          e => e.path === parentFolderPath
        );
        if (!parentFolderPersistenceFile) {
          yield call(console.log, 'parent pers file missing');
          return;
        }

        yield call(
          console.log,
          'parent found ',
          parentFolderPersistenceFile,
          ' for file ',
          newFolderPath
        );

        // create folder
        const parentFolderId = parentFolderPersistenceFile.id;

        const newFolderId: string = yield call(
          createFolderAndReturnId,
          parentFolderId,
          newFolderName
        );
        yield put(
          actions.addPersistenceFile({
            lastSaved: new Date(),
            path: newFolderPath,
            id: newFolderId,
            name: newFolderName,
            parentId: parentFolderId
          })
        );
        yield call(store.dispatch, actions.updateRefreshFileViewKey());
        yield call(
          showSuccessMessage,
          `Folder ${newFolderName} successfully saved to Google Drive.`,
          1000
        );
      } catch (ex) {
        console.error(ex);
        yield call(showWarningMessage, `Error while creating folder.`, 1000);
      } finally {
        yield call(store.dispatch, actions.enableFileSystemContextMenus());
      }
    }
  );

  yield takeEvery(
    PERSISTENCE_DELETE_FILE,
    function* ({ payload }: ReturnType<typeof actions.persistenceDeleteFile>) {
      yield call(store.dispatch, actions.disableFileSystemContextMenus());

      try {
        const filePath = payload;
        yield call(console.log, 'delete file ', filePath);

        // look for file
        const persistenceFileArray: PersistenceFile[] = yield select(
          (state: OverallState) => state.fileSystem.persistenceFileArray
        );
        const persistenceFile = persistenceFileArray.find(e => e.path === filePath);
        if (!persistenceFile || persistenceFile.id === '') {
          yield call(console.log, 'cannot find pers file for ', filePath);
          return;
        }
        yield call(deleteFileOrFolder, persistenceFile.id); // assume this succeeds all the time? TODO
        yield put(actions.deletePersistenceFile(persistenceFile));
        yield call(store.dispatch, actions.updateRefreshFileViewKey());
        yield call(
          showSuccessMessage,
          `${persistenceFile.name} successfully deleted from Google Drive.`,
          1000
        );
      } catch (ex) {
        console.error(ex);
        yield call(showWarningMessage, `Error while deleting file.`, 1000);
      } finally {
        yield call(store.dispatch, actions.enableFileSystemContextMenus());
      }
    }
  );

  yield takeEvery(
    PERSISTENCE_DELETE_FOLDER,
    function* ({ payload }: ReturnType<typeof actions.persistenceDeleteFolder>) {
      yield call(store.dispatch, actions.disableFileSystemContextMenus());

      try {
        const folderPath = payload;
        yield call(console.log, 'delete folder ', folderPath);

        // identical to delete file
        const persistenceFileArray: PersistenceFile[] = yield select(
          (state: OverallState) => state.fileSystem.persistenceFileArray
        );
        const persistenceFile = persistenceFileArray.find(e => e.path === folderPath);
        if (!persistenceFile || persistenceFile.id === '') {
          yield call(console.log, 'cannot find pers file');
          return;
        }
        yield call(deleteFileOrFolder, persistenceFile.id);
        yield put(actions.deletePersistenceFile(persistenceFile));
        yield call(store.dispatch, actions.updateRefreshFileViewKey());
        yield call(
          showSuccessMessage,
          `Folder ${persistenceFile.name} successfully deleted from Google Drive.`,
          1000
        );
      } catch (ex) {
        console.error(ex);
        yield call(showWarningMessage, `Error while deleting folder.`, 1000);
      } finally {
        yield call(store.dispatch, actions.enableFileSystemContextMenus());
      }
    }
  );

  yield takeEvery(
    PERSISTENCE_RENAME_FILE,
    function* ({
      payload: { oldFilePath, newFilePath }
    }: ReturnType<typeof actions.persistenceRenameFile>) {
      yield call(store.dispatch, actions.disableFileSystemContextMenus());

      try {
        yield call(console.log, 'rename file ', oldFilePath, ' to ', newFilePath);

        // look for file
        const persistenceFileArray: PersistenceFile[] = yield select(
          (state: OverallState) => state.fileSystem.persistenceFileArray
        );
        const persistenceFile = persistenceFileArray.find(e => e.path === oldFilePath);
        if (!persistenceFile) {
          yield call(console.log, 'cannot find pers file');
          return;
        }

        // new name TODO: modify action so name is supplied?
        const regexResult = filePathRegex.exec(newFilePath)!;
        const newFileName = regexResult[2] + regexResult[3];

        // call gapi
        yield call(renameFileOrFolder, persistenceFile.id, newFileName);

        // handle pers file
        yield put(
          actions.updatePersistenceFilePathAndNameByPath(oldFilePath, newFilePath, newFileName)
        );
        yield call(store.dispatch, actions.updateRefreshFileViewKey());
        yield call(
          showSuccessMessage,
          `${newFileName} successfully renamed in Google Drive.`,
          1000
        );
      } catch (ex) {
        console.error(ex);
        yield call(showWarningMessage, `Error while renaming file.`, 1000);
      } finally {
        yield call(store.dispatch, actions.enableFileSystemContextMenus());
      }
    }
  );

  yield takeEvery(
    PERSISTENCE_RENAME_FOLDER,
    function* ({
      payload: { oldFolderPath, newFolderPath }
    }: ReturnType<typeof actions.persistenceRenameFolder>) {
      yield call(store.dispatch, actions.disableFileSystemContextMenus());

      try {
        yield call(console.log, 'rename folder ', oldFolderPath, ' to ', newFolderPath);

        // look for folder
        const persistenceFileArray: PersistenceFile[] = yield select(
          (state: OverallState) => state.fileSystem.persistenceFileArray
        );
        const persistenceFile = persistenceFileArray.find(e => e.path === oldFolderPath);
        if (!persistenceFile) {
          yield call(console.log, 'cannot find pers file for ', oldFolderPath);
          return;
        }

        // new name TODO: modify action so name is supplied?
        const regexResult = filePathRegex.exec(newFolderPath)!;
        const newFolderName = regexResult[2] + regexResult[3];

        // old name TODO: modify action so name is supplied?
        const regexResult2 = filePathRegex.exec(oldFolderPath)!;
        const oldFolderName = regexResult2[2] + regexResult2[3];

        // call gapi
        yield call(renameFileOrFolder, persistenceFile.id, newFolderName);

        // handle pers file
        yield put(
          actions.updatePersistenceFolderPathAndNameByPath(
            oldFolderPath,
            newFolderPath,
            oldFolderName,
            newFolderName
          )
        );
        yield call(store.dispatch, actions.updateRefreshFileViewKey());
        yield call(
          showSuccessMessage,
          `Folder ${newFolderName} successfully renamed in Google Drive.`,
          1000
        );

        const [currFolderObject] = yield select((state: OverallState) => [
          state.playground.persistenceFile
        ]);
        if (currFolderObject.name === oldFolderName) {
          // update playground PersistenceFile
          yield put(
            actions.playgroundUpdatePersistenceFolder({ ...currFolderObject, name: newFolderName })
          );
        }
      } catch (ex) {
        console.error(ex);
        yield call(showWarningMessage, `Error while renaming folder.`, 1000);
      } finally {
        yield call(store.dispatch, actions.enableFileSystemContextMenus());
      }
    }
  );
}

interface IPlaygroundConfig {
  chapter: string;
  variant: string;
  external: string;
}

// Reason for this: we don't want to initialise and load the gapi JS until
// it is actually needed
// Note the following properties of Promises:
// - It is okay to call .then() multiple times on the same promise
// - It is okay to call resolve() multiple times (the subsequent resolves have
//   no effect
// See ECMA 262: https://www.ecma-international.org/ecma-262/6.0/#sec-promise-resolve-functions
// These two properties make a Promise a good way to have a lazy singleton
// (in this case, the singleton is not an object but the initialisation of the
// gapi library)
let startInitialisation: (_: void) => void;
const initialisationPromise: Promise<void> = new Promise(res => {
  startInitialisation = res;
}).then(initialise);

// only called once
async function initialise() {
  // initialize GIS client
  await new Promise<void>(
    (resolve, reject) =>
      (googleProvider = new GoogleOAuthProvider({
        clientId: Constants.googleClientId!,
        onScriptLoadSuccess: resolve,
        onScriptLoadError: reject
      }))
  );

  // load and initialize gapi.client
  await new Promise<void>((resolve, reject) =>
    gapi.load('client', {
      callback: resolve,
      onerror: reject
    })
  );
  await gapi.client.init({
    discoveryDocs: DISCOVERY_DOCS
  });
}

function* handleUserChanged(accessToken: string | null) {
  if (accessToken === null) {
    yield put(actions.removeGoogleUserAndAccessToken());
  } else {
    const email: string | undefined = yield call(getUserProfileDataEmail);
    if (!email) {
      yield put(actions.removeGoogleUserAndAccessToken());
    } else {
      yield put(store.dispatch(actions.setGoogleUser(email)));
      yield put(store.dispatch(actions.setGoogleAccessToken(accessToken)));
    }
  }
}

function* ensureInitialised() {
  startInitialisation();
  yield initialisationPromise;
}

// called multiple times
function* ensureInitialisedAndAuthorised() {
  yield call(ensureInitialised);
  const currToken: GoogleApiOAuth2TokenObject = yield call(gapi.client.getToken);

  if (currToken === null) {
    yield call(googleLogin);
  } else {
    // check if loaded token is still valid
    const email: string | undefined = yield call(getUserProfileDataEmail);
    const isValid = email ? true : false;
    if (!isValid) {
      yield call(googleLogin);
    }
  }
}

function getUserProfileDataEmail(): Promise<string | undefined> {
  return gapi.client
    .request({
      path: USER_INFO_PATH
    })
    .then(r => r.result.email)
    .catch(() => undefined);
}

type PickFileResult =
  | { id: string; name: string; mimeType: string; parentId: string; picked: true }
  | { picked: false };

function pickFile(
  title: string,
  options?: {
    pickFolders?: boolean;
    showFolders?: boolean;
    showFiles?: boolean;
    rootFolder?: string;
  }
): Promise<PickFileResult> {
  const pickFolders = typeof options?.pickFolders === 'undefined' ? false : options?.pickFolders;
  const showFolders = typeof options?.showFolders === 'undefined' ? true : options?.showFolders;
  const showFiles = typeof options?.showFiles === 'undefined' ? true : options?.showFiles;
  return new Promise(res => {
    gapi.load('picker', () => {
      const view = new google.picker.DocsView(
        showFiles ? google.picker.ViewId.DOCS : google.picker.ViewId.FOLDERS
      );
      if (options?.rootFolder) {
        view.setParent(options.rootFolder);
      }
      view.setOwnedByMe(true);
      view.setIncludeFolders(showFolders);
      view.setSelectFolderEnabled(pickFolders);
      view.setMode(google.picker.DocsViewMode.LIST);

      const picker = new google.picker.PickerBuilder()
        .setTitle(title)
        .enableFeature(google.picker.Feature.NAV_HIDDEN)
        .addView(view)
        .setOAuthToken(gapi.client.getToken().access_token)
        .setAppId(Constants.googleAppId!)
        .setDeveloperKey(Constants.googleApiKey!)
        .setCallback((data: any) => {
          switch (data[google.picker.Response.ACTION]) {
            case google.picker.Action.PICKED: {
              console.log('data', data);
              const { id, name, mimeType, parentId } = data.docs[0];
              res({ id, name, mimeType, parentId, picked: true });
              break;
            }
            case google.picker.Action.CANCEL: {
              res({ picked: false });
              break;
            }
          }
        })
        .build();
      picker.setVisible(true);
    });
  });
}

async function getFilesOfFolder( // recursively get files
  folderId: string,
  currFolderName: string,
  currPath: string = '' // pass in name of folder picked
) {
  console.log(folderId, currPath, currFolderName);
  let fileList: gapi.client.drive.File[] | undefined;

  await gapi.client.drive.files
    .list({
      q: `'${folderId}' in parents and trashed = false`
    })
    .then(res => {
      fileList = res.result.files;
    });

  console.log('fileList', fileList);

  if (!fileList || fileList.length === 0) {
    return [
      {
        name: currFolderName,
        id: folderId,
        path: currPath + '/' + currFolderName,
        isFolder: true
      }
    ];
  }

  let ans: any[] = []; // TODO: add type for each resp?
  for (const currFile of fileList) {
    if (currFile.mimeType === MIME_FOLDER) {
      // folder
      ans = ans.concat(
        await getFilesOfFolder(currFile.id!, currFile.name!, currPath + '/' + currFolderName)
      );
      ans.push({
        name: currFile.name,
        id: currFile.id,
        parentId: folderId,
        path: currPath + '/' + currFolderName + '/' + currFile.name,
        isFolder: true
      });
    } else {
      // file
      ans.push({
        name: currFile.name,
        id: currFile.id,
        parentId: folderId,
        path: currPath + '/' + currFolderName + '/' + currFile.name
      });
    }
  }

  return ans;
}

async function getIdOfFileOrFolder(parentFolderId: string, fileName: string): Promise<string> { // returns string id or empty string if failed
  let fileList: gapi.client.drive.File[] | undefined;

  await gapi.client.drive.files
    .list({
      q: `'${parentFolderId}' in parents and trashed = false and name = '${fileName}'`
    })
    .then(res => {
      fileList = res.result.files;
    });

  console.log(fileList);

  if (!fileList || fileList.length === 0) {
    // file does not exist
    console.log('file not exist: ' + fileName);
    return '';
  }

  //check if file is correct
  if (fileList![0].name === fileName) {
    // file is correct
    return fileList![0].id!;
  } else {
    return '';
  }
}

function deleteFileOrFolder(id: string): Promise<any> {
  return gapi.client.drive.files.delete({
    fileId: id
  });
}

function renameFileOrFolder(id: string, newName: string): Promise<any> {
  return gapi.client.drive.files.update({
    fileId: id,
    resource: { name: newName }
  });
}

async function getContainingFolderIdRecursively(
  parentFolders: string[],
  topFolderId: string,
  currDepth: integer = 0
): Promise<{ id: string; parentId: string }> {
  if (parentFolders[0] === '' || currDepth === parentFolders.length) {
    return { id: topFolderId, parentId: '' };
  }
  const currFolderName = parentFolders[parentFolders.length - 1 - currDepth];

  const immediateParentFolderId = await getContainingFolderIdRecursively(
    parentFolders,
    topFolderId,
    currDepth + 1
  ).then(r => r.id);

  let folderList: gapi.client.drive.File[] | undefined;

  await gapi.client.drive.files
    .list({
      q:
        `'${immediateParentFolderId}' in parents and trashed = false and mimeType = '` +
        "application/vnd.google-apps.folder'"
    })
    .then(res => {
      folderList = res.result.files;
    });

  if (!folderList) {
    console.log('create!', currFolderName);
    const newId = await createFolderAndReturnId(immediateParentFolderId, currFolderName);
    return { id: newId, parentId: immediateParentFolderId };
  }

  console.log('folderList gcfir', folderList);

  for (const currFolder of folderList) {
    if (currFolder.name === currFolderName) {
      console.log('found ', currFolder.name, ' and id is ', currFolder.id);
      return { id: currFolder.id!, parentId: immediateParentFolderId };
    }
  }

  console.log('create!', currFolderName);
  const newId = await createFolderAndReturnId(immediateParentFolderId, currFolderName);
  return { id: newId, parentId: immediateParentFolderId };
}

function createFile(
  filename: string,
  parent: string,
  mimeType: string,
  contents: string = '',
  config: IPlaygroundConfig | {}
): Promise<PersistenceFile> {
  const name = filename;
  const meta = {
    name,
    mimeType,
    parents: [parent], //[id of the parent folder as a string]
    appProperties: {
      source: true,
      ...config
    }
  };

  const { body, headers } = createMultipartBody(meta, contents, mimeType);

  return gapi.client
    .request({
      path: UPLOAD_PATH,
      method: 'POST',
      params: {
        uploadType: 'multipart'
      },
      headers,
      body
    })
    .then(({ result }) => ({ id: result.id, parentId: parent, name: result.name }));
}

function updateFile(
  id: string,
  name: string,
  mimeType: string,
  contents: string = '',
  config: IPlaygroundConfig | {}
): Promise<any> {
  const meta = {
    name,
    mimeType,
    appProperties: {
      source: true,
      ...config
    }
  };

  console.log('META', meta);

  const { body, headers } = createMultipartBody(meta, contents, mimeType);

  return gapi.client.request({
    path: UPLOAD_PATH + '/' + id,
    method: 'PATCH',
    params: {
      uploadType: 'multipart'
    },
    headers,
    body
  });
}

function createFolderAndReturnId(parentFolderId: string, folderName: string): Promise<string> {
  const name = folderName;
  const mimeType = MIME_FOLDER;
  const meta = {
    name,
    mimeType,
    parents: [parentFolderId] //[id of the parent folder as a string]
  };

  const { body, headers } = createMultipartBody(meta, '', mimeType);

  return gapi.client
    .request({
      path: UPLOAD_PATH,
      method: 'POST',
      params: {
        uploadType: 'multipart'
      },
      headers,
      body
    })
    .then(res => res.result.id);
}

function createMultipartBody(
  meta: any,
  contents: string,
  contentsMime: string
): { body: string; boundary: string; headers: { [name: string]: string } } {
  const metaJson = JSON.stringify(meta);
  let boundary: string;
  do {
    boundary = generateBoundary();
  } while (metaJson.includes(boundary) || contents.includes(boundary));

  const body = `--${boundary}
Content-Type: application/json; charset=utf-8

${JSON.stringify(meta)}
--${boundary}
Content-Type: ${contentsMime}

${contents}
--${boundary}--
`;

  return { body, boundary, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

// Adapted from
// https://github.com/form-data/form-data/blob/master/lib/form_data.js

// Copyright (c) 2012 Felix Geisendörfer (felix@debuggable.com) and contributors

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

function generateBoundary(): string {
  // This generates a 50 character boundary similar to those used by Firefox.
  // They are optimized for boyer-moore parsing.
  let boundary = '--------------------------';
  for (let i = 0; i < 24; i++) {
    boundary += Math.floor(Math.random() * 10).toString(16);
  }

  return boundary;
}

// End adapted part

export default persistenceSaga;
