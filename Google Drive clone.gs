/*
Cloning from one google drive to another across organizations is REALLY hard. You can *move* files, but not folders. 
There's no built in way to copy a whole directory tree from one drive to another. If you use Drive for Desktop you can't copy or move native google file formats (Docs, sheets, slides, ect.)
This script attempts to do the following: 
Copy all files & folders from one google drive folder to another
Recreate sharing and star settings on files and folders
Handle situations where the clone job takes longer than the max runtime 


Warning: When file and folder sharing permissions get copied it *will* send notification emails to editors and viewers. This can create a LOT of emails. 

Setup: 
  1. Modify targetParentFolderId to be the folder ID of the destination folder. 
    Note: you need a FOLDER ID here not a shared drive ID. 
  2. Modify sourceFolderId to be the folder ID of the source folder. 
    Note: You can use DriveApp.getRootFolder().getId() if you want to copy an entire drive. 
  3. Optional - set "skipPhase" to true for any job phases you want to skip. Sharing and star settings are good options for skippage if you don't need them. They can be very slow. 
  4. Optional - set "moveFiles" to true if you want to move files to their destination. Copying files can break links in spreadsheets and forms, so moving may be more desireable.
Usage: 
1. Run driveClone
    If the script runs longer than maxRuntime it creates a trigger to rerun the script after msToNextRun milliseconds. It keeps doing this until the job is completed. 
    If the script is completed successfully it emails the owner of the script and notifies them that the job is complete. 
*/

//ID of the Source folder
const sourceFolderId = "SOURCEFOLDERID";
//const sourceFolderId = DriveApp.getRootFolder().getId();
//ID of the destination folder. 
const targetParentFolderId = '1dZY1c9SD-6XOPuQh81aCe3cNa5zJj3Xs';
//The temporary state filename - it will be written to the root of the source folder. 
const statefileFilename = 'driveClone.json';
//Official max runtime is 6 minutes for unpaid and 30 min for paid accounts. Some processes aren't easy to break out of. 
//Go with 5 min here to be safe. 
const maxRuntime = 300 * 1000;
//How long to wait to trigger another run of runCloneJob. 30 seconds seems fair. 
const msToNextRun = 30000;
//This is the global object that's going to hold all details about the clone job. 
let cloneJob;
//Set to true if you want to MOVE files to the destination. 
let moveFiles = false;

//Job is divided into phases. Phase 0 is the only one that can't restart if it runs out of time. 
//Testing indicates that you should be able to traverse a thousand nested folders in 5 min. 
//If it does timeout during phase 0 you'll need to have it traverse fewer folders. 
/*Clone job phases: 
  0. Initial Drive traversal. 
  1. Create Folders
  2. Copy folder Sharing
  3. Copy folder Stars
  4. Build list of files to copy
  5. Copy files
  6. Copy file sharing
  7. copy file stars
  */
//----------------------------------------------\\
function driveClone() {
  cloneJob = readStateFile_();
  clearTriggers_();
  cloneJob.timeout = Date.now() + maxRuntime;

//You can choose to skip certain phases to save time on the copy job. Set skipPhase to true. 
//There's no sanity checking. If you choose to skip a required phase it will let you, but the rest of the process won't work. 
//You probably only want to try to skip the sharing and starring phases. You could skip the file copy phase and it would just create a directory tree. 
  const jobPhases = [
    { logMessage: "Phase 0 - Drive Traversal", callbackFunction: cloneJobSetup_, travObject: false , skipPhase: false},
    { logMessage: "Phase 1 - Creating Folders", callbackFunction: createFolders_, travObject: true , skipPhase: false},
    { logMessage: "Phase 2 - Folder Sharing", callbackFunction: setFolderSharing_, travObject: true , skipPhase: false},
    { logMessage: "Phase 3 - Folder Stars", callbackFunction: setFolderStars_, travObject: true , skipPhase: false},
    { logMessage: "Phase 4 - Build File List", callbackFunction: findFiles_, travObject: true , skipPhase: false},
    { logMessage: "Phase 5 - File Copy/Move", callbackFunction: copyFiles_, travObject: true , skipPhase: false},
    { logMessage: "Phase 6 - File Sharing", callbackFunction: setFileSharing_, travObject: true , skipPhase: false},
    { logMessage: "Phase 7 - File Stars", callbackFunction: setFileStars_, travObject: true , skipPhase: false},
    { logMessage: "Phase 8 - Cleanup", callbackFunction: cloneJobFinish_, travObject: false , skipPhase: false},
  ];

//If we're moving files we can skip the file sharing and file stars. 
  if(moveFiles){
    jobPhases[6].skipPhase=true;
    jobPhases[7].skipPhase = true;
  }

  for (let currentPhase = cloneJob.phase; currentPhase < jobPhases.length; currentPhase++) {
    Logger.log(jobPhases[currentPhase].logMessage);

    if(jobPhases[currentPhase].skipPhase){
      cloneJob.phase++;
      Logger.log("Skipping this phase");
      continue;
    }
    //Some phases need to traverse cloneJob.tree and some don't. That's what travObject denotes. 
    if (jobPhases[currentPhase].travObject) {
      traverseObject_(cloneJob.tree, jobPhases[currentPhase].callbackFunction);
    }
    //If we're not traversing the cloneJob object, just call the callback function. 
    else {
      jobPhases[currentPhase].callbackFunction();
    }
    if (!isTimedOut_()) {
      cloneJob.phase++;
      writeStateFile_(cloneJob);
    }
    else {
      Logger.log("Execution time Exceeded - Setting trigger")
      ScriptApp.newTrigger("driveClone")
        .timeBased()
        .after(msToNextRun)
        .create();
      break;
    }
  }
  writeStateFile_(cloneJob);
}
//----------------------------------------------\\
function cloneJobSetup_() {

  let rootFolder = DriveApp.getFolderById(sourceFolderId);
  let rootName = rootFolder.getName()
  let rootId = rootFolder.getId();

  let root = {
    name: rootName,
    id: rootId,
    parentId: targetParentFolderId,
    phase: 0,
    destId: "",
    isStarred: false,
    folders: [],
    files: [],
    editors: [],
    viewers: []
  };
  cloneJob.tree.push(root);
  traverseDrive_(cloneJob.tree);
}
//----------------------------------------------\\
function cloneJobFinish_() {
  cloneJob.end = Date.now();
  cloneJob.totalRuntime = (cloneJob.end - cloneJob.start) / 60000
  MailApp.sendEmail(Session.getActiveUser().getEmail(), "Drive clone complete", "Your drive clone job has completed successfully\n\n" +
    "\nFolders copied: " + cloneJob.folderCount +
    "\nFiles copied: " + cloneJob.fileCount +
    "\nFailures: " + cloneJob.failures +
    "\nTotal Runtime: " + Math.round(cloneJob.totalRuntime) + " Minutes\n");
}
//----------------------------------------------\\
function traverseDrive_(driveTree) {
  for (let currentFolder of driveTree) {
    let driveFolder = DriveApp.getFolderById(currentFolder.id);
    let sourceName = driveFolder.getName();
    let sourceID = driveFolder.getId();
    Logger.log("Entering folder " + sourceName + " ID: " + sourceID);

    let driveSubFolders = driveFolder.getFolders();
    while (driveSubFolders.hasNext()) {
      let driveSubFolder = driveSubFolders.next();
      let newSubFolder = {
        name: driveSubFolder.getName(),
        id: driveSubFolder.getId(),
        parentId: null,
        phase: 0,
        destId: "",
        isStarred: false,
        folders: [],
        files: [],
        editors: [],
        viewers: []
      };
      currentFolder.folders.push(newSubFolder);
    }
    if (currentFolder.folders && currentFolder.folders.length > 0) {
      traverseDrive_(currentFolder.folders);
    }
  }
}
//----------------------------------------------\\
function traverseObject_(driveTree, callback) {
  if (isTimedOut_()) {
    return;
  }
  for (let currentFolder of driveTree) {
    callback(currentFolder);
    if (currentFolder.folders && currentFolder.folders.length > 0 && !isTimedOut_()) {
      traverseObject_(currentFolder.folders, callback);
    }
  }
}
//----------------------------------------------\\
function createFolders_(folder) {
  if (folder.phase < cloneJob.phase && !isTimedOut_()) {
    Logger.log("Creating folder " + folder.name);
    let driveParentFolder = DriveApp.getFolderById(folder.parentId);
    let newDriveFolder = driveParentFolder.createFolder(folder.name);
    let newFolderId = newDriveFolder.getId();
    folder.destId = newFolderId;
    cloneJob.folderCount++;
    folder.phase = 1;
    for (let subfolder of folder.folders) {
      subfolder.parentId = newFolderId;
    }
  }
}
//----------------------------------------------\\
function setFolderSharing_(folder) {
  if (folder.phase < cloneJob.phase && !isTimedOut_()) {
    let driveSourceFolder = DriveApp.getFolderById(folder.id);
    let driveDestFolder = DriveApp.getFolderById(folder.destId);
    let editors = getUserEmails_(driveSourceFolder, "editors");
    if (editors && editors.length > 0) {
      Logger.log("Adding editors for " + folder.name);
      driveDestFolder.addEditors(editors);
      folder.editors = editors;
    }
    let viewers = getUserEmails_(driveSourceFolder, "viewers");
    if (viewers && viewers.length > 0) {
      Logger.log("Adding viewers for " + folder.name);
      driveDestFolder.addViewers(viewers);
      folder.viewers = viewers;
    }
  }
  folder.phase = 2;
}
//----------------------------------------------\\
function setFileSharing_(folder) {
  if (folder.phase < cloneJob.phase) {
    for (let file of folder.files) {
      if (isTimedOut_()) {
        return;
      }
      let driveDestFile = DriveApp.getFileById(file.destId);
      let driveSourceFile = DriveApp.getFileById(file.id);
      let editors = getUserEmails_(driveSourceFile, "editors");
      if (editors && editors.length > 0) {
        Logger.log("Adding editors for " + file.name);
        driveDestFile.addEditors(editors);
        file.editors = editors;
      }
      let viewers = getUserEmails_(driveSourceFile, "viewers");
      if (viewers && viewers.length > 0) {
        Logger.log("Adding viewers for " + file.name);
        driveDestFile.addViewers(viewers);
        file.viewers = viewers;
      }
    }
  }
  folder.phase = 6;
}
//----------------------------------------------\\
function setFolderStars_(folder) {
  if (folder.phase < cloneJob.phase) {
    let driveSourceFolder = DriveApp.getFolderById(folder.id);
    let driveDestFolder = DriveApp.getFolderById(folder.destId);
    let sourceIsStarred = driveSourceFolder.isStarred();
    folder.isStarred = sourceIsStarred;

    if (sourceIsStarred) {
      Logger.log("Setting Star on " + folder.name);
      driveDestFolder.setStarred(sourceIsStarred);
    }
    folder.phase = 3;
  }
}
//----------------------------------------------\\
function setFileStars_(folder) {
  //Add better timeout detection here. 
  if (folder.phase < cloneJob.phase) {
    for (let file of folder.files) {
      if (isTimedOut_()) {
        return;
      }
      let driveSourceFile = DriveApp.getFolderById(file.id);
      let driveDestFile = DriveApp.getFolderById(file.destId);
      let sourceIsStarred = driveSourceFile.isStarred();
      if (sourceIsStarred) {
        Logger.log("Setting Star on " + file.name);
        driveDestFile.setStarred(sourceIsStarred);
        file.isStarred = sourceIsStarred;
      }
    }
  }
  folder.phase = 7;
}
//----------------------------------------------\\
function findFiles_(folder) {
  if (folder.phase < cloneJob.phase && !isTimedOut_()) {
    let driveSourceFolder = DriveApp.getFolderById(folder.id);
    let driveFiles = driveSourceFolder.getFiles();
    while (driveFiles.hasNext()) {
      let nextDriveFile = driveFiles.next();
      let nextDriveFileName = nextDriveFile.getName();
      //Don't copy the statefile over. 
      if (nextDriveFileName == statefileFilename && folder.id == sourceFolderId) {
        continue;
      }
      let newFile = {
        name: nextDriveFile.getName(),
        id: nextDriveFile.getId(),
        destId: null,
        isStarred: false,
        editors: [],
        viewers: [],
        size: nextDriveFile.getSize()
      }
      folder.files.push(newFile);
      Logger.log("Found file " + newFile.name);
    }
  }
  folder.phase = 4;
}
//----------------------------------------------\\
function copyFiles_(folder) {
  if (folder.phase < cloneJob.phase) {
    for (let file of folder.files) {
      if (isTimedOut_()) {
        return;
      }
      //Skip this file if we've already copied it. 
      if (file.destId) {
        continue;
      }
      Logger.log("Copying/Moving file " + file.name);
      let driveSourceFile = DriveApp.getFileById(file.id);
      let driveDestFolder = DriveApp.getFolderById(folder.destId);
      try {
        if (moveFiles) {
          driveSourceFile.moveTo(driveDestFolder);
          file.destId = file.id;
          cloneJob.fileCount++;
        }
        else {
          driveDestFile = driveSourceFile.makeCopy(file.name, driveDestFolder);
          cloneJob.fileCount++;
          file.destId = driveDestFile.getId();
        }
      }
      catch (error) {
        Logger.log("Failed copying file " + file.name + " " + error);
        file.destId = "FAILED";
        cloneJob.failures++;
        cloneJob.failureList.push({ "name": sourceFile.getName(), "id": sourceFile.getId(), "message": error });
      }
    }
  }
  folder.phase = 5;
}
//----------------------------------------------\\
function getUserEmails_(obj, userClass) {
  let rv = [];
  let userlist = [];
  if (userClass == "editors") {
    userList = obj.getEditors();
  }
  else {
    userlist = obj.getViewers();
  }
  for (let i = 0; i < userList.length; i++) {
    rv.push(userList[i].getEmail());
  }
  return rv;
}
//----------------------------------------------\\
function readStateFile_() {
  let destFolder = DriveApp.getFolderById(sourceFolderId);
  let fileList = destFolder.getFilesByName(statefileFilename);
  let rv = null;
  if (fileList.hasNext()) {
    var file = fileList.next();
    rv = JSON.parse(file.getBlob().getDataAsString());
  }
  else {
    rv = {
      start: Date.now(),
      timeout: Date.now() + maxRuntime,
      phase: 0,
      end: 0,
      totalRuntime: 0,
      fileCount: 0,
      folderCount: 0,
      failures: 0,
      failureList: [],
      tree: []
    };
  }
  return rv;
}
//----------------------------------------------\\
function writeStateFile_(content) {
  let destFolder = DriveApp.getFolderById(sourceFolderId);
  let fileList = destFolder.getFilesByName(statefileFilename);
  if (fileList.hasNext()) {
    // State file exists - replace content
    var file = fileList.next();
    file.setContent(JSON.stringify(content));
  }
  else {
    // state file doesn't exist. Create it. 
    destFolder.createFile(statefileFilename, JSON.stringify(content));
  }
}
//----------------------------------------------\\
function clearTriggers_() {
  let triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
    Utilities.sleep(1000);
  }
}
//----------------------------------------------\\
function isTimedOut_() {
  if (Date.now() >= cloneJob.timeout) {
    Logger.log("Timeout");
    return true;
  }
  else {
    return false;
  }
}
