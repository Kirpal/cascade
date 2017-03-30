const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const pump = require('pump');
const rangeParser = require('range-parser');
const express = require('express');
const request = require('request');
const windowStateKeeper = require('electron-window-state');
const bodyParser = require('body-parser');
const menubar = require('menubar');
const torrent = require('./torrent');
const resume = require('./resume');
const store = require('./store');
const storeProgress = require('./storeProgress');
const storeConfig = require('./storeConfig');
require('electron-debug')();

const api = express();
const streamPort = storeConfig.get('port').value;
const libraryLocation = storeConfig.get('library').value;
const current = {};
let torrents = {};

// for the rest api
api.use(bodyParser.json());
api.use(bodyParser.urlencoded({ extended: true }));

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
const windows = [];

// sets buttons on taskbar hover (windows)
function setThumbar(state, window) {
  if (state) {
    window.setThumbarButtons([
      {
        tooltip: 'Pause',
        icon: path.join(__dirname, 'icons', 'thumbar-pause.png'),
        click() {
          setThumbar(false);
          window.webContents.send('playback', false);
        },
      },
    ]);
  } else {
    window.setThumbarButtons([
      {
        tooltip: 'Play',
        icon: path.join(__dirname, 'icons', 'thumbar-play.png'),
        click() {
          setThumbar(true);
          window.webContents.send('playback', true);
        },
      },
    ]);
  }
}


// change the theme by changing the html file
function changeTheme(dark, win) {
  win.loadURL(`file://${__dirname}/index-${dark ? 'dark' : 'light'}.html`);
}

// Create the browser window.
function createWindow() {
  // load saved window state with fallback to defaults
  const winState = windowStateKeeper({
    defaultWidth: 1000,
    defaultHeight: 800,
  });
  const win = new BrowserWindow({
    x: winState.x,
    y: winState.y,
    width: winState.width,
    height: winState.height,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icons', 'icon.png'),
    backgroundColor: '#fff',
    show: false,
  });

  current[win.id] = {
    movie: {},
    volume: 0.75,
    progress: 0,
    playing: false,
    fullscreen: false,
  };
  // resumes all incomplete torrents
  torrents = resume(win);

  // manage window events, state, and size
  winState.manage(win);

  // create and set application menu
  const appMenuTemplate = [
    {
      label: 'Film Reel',
      submenu: [
        {
          label: 'About Film Reel',
          click: () => {
            shell.openExternal('https://filmreelapp.com');
          },
        },
        {
          type: 'separator',
        },
        {
          role: 'quit',
        },
      ],
    },
    {
      label: 'Controls',
      submenu: [
        {
          enabled: false,
          label: 'Play/Pause',
          click: () => {
            setThumbar(null, win);
            win.webContents.send('playback', null);
          },
        },
        {
          enabled: false,
          label: 'Volume',
          submenu: [
            {
              label: '0%',
              click: () => {
                win.webContents.send('volume', { volume: 0, update: true });
              },
            },
            {
              label: '25%',
              click: () => {
                win.webContents.send('volume', { volume: 0.25, update: true });
              },
            },
            {
              label: '50%',
              click: () => {
                win.webContents.send('volume', { volume: 0.5, update: true });
              },
            },
            {
              label: '100%',
              click: () => {
                win.webContents.send('volume', { volume: 1, update: true });
              },
            },
          ],
        },
        {
          enabled: false,
          label: 'Toggle Full Screen',
          click: () => {
            win.setFullScreen(!current.fullscreen);
            current.fullscreen = !current.fullscreen;
            win.webContents.send('fullscreen', null);
          },
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Report Issue',
          click: () => {
            shell.openExternal('https://github.com/kirpal/filmreel/issues');
          },
        },
        {
          label: 'View Source Code (GitHub)',
          click: () => {
            shell.openExternal('https://github.com/kirpal/filmreel');
          },
        },
        {
          type: 'separator',
        },
        {
          label: 'Check For Updates',
          click: () => {
            autoUpdater.checkForUpdates();
          },
        },
      ],
    },
  ];
  const appMenu = Menu.buildFromTemplate(appMenuTemplate);
  Menu.setApplicationMenu(appMenu);

  // and load the index.html of the app.
  win.loadURL(`file://${__dirname}/index-${storeConfig.get('dark').value ? 'dark' : 'light'}.html`);
  win.once('ready-to-show', () => {
    win.show();
  });

  // open new tab links in default browser
  win.webContents.on('new-window', (e, url) => {
    e.preventDefault();
    shell.openExternal(url);
  });

  // Emitted when the window is closed.
  win.on('closed', () => {
    // remove window from windows array
    delete windows[windows.indexOf(win)];
  });

  windows.push(win);
}

// ready to make windows
app.on('ready', () => {
  // check for updates if autoaupdates are on
  if (storeConfig.get('updates').value) {
    autoUpdater.checkForUpdates();
  }
  // when an update is downloaded ask the user if they would like to quit and install
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(BrowserWindow.getFocusedWindow(), { type: 'info', buttons: ['No', 'Yes'], defaultId: 1, title: 'Update Downloaded', message: 'An update has been downloaded. Restart Film Reel to install it. Restart now?', cancelId: 0 }, (response) => {
      if (response === 1) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  // make menubar app that displays active downloads
  const dir = path.join(__dirname, 'menubar');
  let icon = path.join(__dirname, 'menubar', 'icon.png');

  if (process.platform === 'darwin') {
    icon = path.join(__dirname, 'menubar', 'icon-mac.png');
  }

  menubar({ dir, icon });

  createWindow();
});

// when another instance is created, stop it and make a new window
const shouldQuit = app.makeSingleInstance(createWindow);

if (shouldQuit) {
  app.quit();
}

app.on('activate', () => {
  // create window on mac if icon pressed
  if (windows.length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  // stop all torrents
  Object.keys(torrents).forEach((id) => {
    torrents[id].end();
    delete torrents[id];
  });
});

// get data for the browsing page's windows
ipcMain.on('getPage', (event, page) => {
  if (page === 'home') {
    // get template markdown file from server and store locally
    request('https://filmreelapp.com/home.md', (error, response, body) => {
      if (!error && response.statusCode === 200) {
        fs.writeFileSync(path.join(app.getPath('userData'), 'home.md'), body);
      }
    });

    // get recent movies and get stored template markdown from file
    let recentMovies;
    let homeTemplate;
    if (storeProgress.getRecent().length > 0) {
      recentMovies = `{{${storeProgress.getRecent().join('}}{{')}}}`;
    } else {
      recentMovies = '';
    }

    try {
      homeTemplate = fs.readFileSync(path.join(app.getPath('userData'), 'home.md'), 'utf8').replace(/\{\{RECENT\}\}/g, recentMovies);
    } catch (err) {
      if (err.code === 'ENOENT') {
        homeTemplate = `# Recent\n\n${recentMovies}`;
      }
    }
    event.returnValue = homeTemplate;
  } else if (page === 'library') {
    // reload library and get list of movies in it
    store.reload();
    event.returnValue = store.get();
  }
});

// send app version
ipcMain.on('getVersion', (event) => {
  event.returnValue = app.getVersion();
});

// respond with stored config
ipcMain.on('getConfig', (event) => {
  event.returnValue = storeConfig.getAll();
});

// store setting
ipcMain.on('storeConfig', (event, config) => {
  // if setting is in config file
  if (Object.keys(storeConfig.getAll()).indexOf(config.setting) !== -1) {
    if (storeConfig.get(config.setting).type === 'text') {
      if (typeof config.value === 'string') {
        storeConfig.store(config.setting, 'value', config.value);
        event.returnValue = { success: true, stored: config.value };
      } else {
        event.returnValue = { success: false, stored: storeConfig.get(config.setting).value };
      }
    } else if (storeConfig.get(config.setting).type === 'number') {
      if (typeof parseInt(config.value, 10) === 'number') {
        storeConfig.store(config.setting, 'value', config.value);
        event.returnValue = { success: true, stored: config.value };
      } else {
        event.returnValue = { success: false, stored: storeConfig.get(config.setting).value };
      }
    } else if (storeConfig.get(config.setting).type === 'directory') {
      let access;
      try {
        fs.accessSync(config.value, fs.constants.R_OK | fs.constants.W_OK);
        access = true;
      } catch (err) {
        access = false;
      }
      if (fs.existsSync(config.value) && access) {
        storeConfig.store(config.setting, 'value', config.value);
        event.returnValue = { success: true, stored: config.value };
      } else {
        event.returnValue = { success: false, stored: storeConfig.get(config.setting).value };
      }
    } else if (storeConfig.get(config.setting).type === 'boolean') {
      if (typeof config.value === 'boolean') {
        storeConfig.store(config.setting, 'value', config.value);
        event.returnValue = { success: true, stored: config.value };
      } else {
        event.returnValue = { success: false, stored: storeConfig.get(config.setting).value };
      }
    }

    if (config.setting === 'dark') {
      changeTheme(config.value, BrowserWindow.fromWebContents(event.sender));
    }
  }
});

// emitted when movie is played in browse
ipcMain.on('stream', (event, movie) => {
  // the window that sent the message
  const win = BrowserWindow.fromWebContents(event.sender);

  // movie is already downloaded
  const downloaded = (store.get().complete.indexOf(movie.id.toString()) !== -1);

  // start download if it isn't started or already downloaded
  if (!torrents[movie.id] && !downloaded) {
    torrents[movie.id] = torrent(movie, false, ipcMain);
  }
  // open player
  win.loadURL(`file://${__dirname}/player/index.html`);

  // enabled controls section of appmenu
  Menu.getApplicationMenu().items[1].submenu.items.forEach(() => {
    this.enabled = true;
  }, this);

  // set currently playing movie
  current[win.id].movie = movie;
});

// emitted to exit player
ipcMain.on('exitStreaming', (event) => {
  // the window that sent the message
  const win = BrowserWindow.fromWebContents(event.sender);

  // movie object
  const movie = current[win.id].movie;

  // movie is already downloaded
  const downloaded = (store.get().complete.indexOf(movie.id.toString()) !== -1);

  // movies that are playing in other windows
  const currentlyPlaying = Object.keys(current)
  .map(id => (win.id === id ? null : current[id].movie.id));

  // exit fullscreen and remove all player ipc listeners
  win.setFullScreen(false);

  // load main part of app
  win.loadURL(`file://${__dirname}/index.html`);

  // disable controls section of app menu
  Menu.getApplicationMenu().items[1].submenu.items.forEach(() => {
    this.enabled = false;
  }, this);

  // remove thumbar buttons
  win.setThumbarButtons([]);

  // delete torrent if it isn't already downloaded or supposed to be downloaded
  if (!downloaded && !torrents[movie.id].download && currentlyPlaying.indexOf(movie.id) === -1) {
    torrents[movie.id].end();
    delete torrents[movie.id];
  }

  // clear current movie
  current[win.id].movie = {};
});

// sent to get the movie object
ipcMain.on('playMovie', (event) => {
  // the window that sent the message
  const win = BrowserWindow.fromWebContents(event.sender);

  // movie object
  const movie = current[win.id].movie;

  // movie is already downloaded
  const downloaded = (store.get().complete.indexOf(movie.id.toString()) !== -1);

  // respond with movie object and streaming port once torrent is ready
  // or immediately if torrent has already started or finished downloading
  if (!downloaded && !torrents[movie.id].ready) {
    torrents[movie.id].on('ready', () => {
      event.sender.send('playMovie', { movie, downloaded });
      event.sender.send('streamPort', streamPort);
    });
  } else {
    event.sender.send('playMovie', { movie, downloaded });
    event.sender.send('streamPort', streamPort);
  }
});
// when metadata for video is loaded
ipcMain.on('metadata', (event, duration) => {
  // the window that sent the message
  const win = BrowserWindow.fromWebContents(event.sender);

  // movie object
  const movie = current[win.id].movie;

  // set current to starting values and send those to player
  current[win.id].volume = 0.75;
  current[win.id].progress = (typeof storeProgress.get(movie.id) === 'undefined') ? 0 : storeProgress.get(movie.id) * duration;
  current[win.id].duration = duration;
  current[win.id].playing = true;
  event.sender.send('volume', { volume: current.volume, update: true });
  event.sender.send('progress', { progress: current.progress, total: current.duration, update: true });
  event.sender.send('playback', true);
});

// play/pause
ipcMain.on('playback', (event, state) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // set thumbar buttons accordingly
  setThumbar(state, win);

  // set current playback state
  current[win.id].playing = (state === null)
  ? !current[win.id].playing : state;

  // reply to player
  event.sender.send('playback', state);
});

// volume change
ipcMain.on('volume', (event, data) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // set current volume
  current[win.id].volume = data.volume;

  // reply to player
  event.sender.send('volume', data);
});

// progress update
ipcMain.on('progress', (event, data) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // store progress in progress.json
  storeProgress.store(data.progress, data.total, data.id);

  // set current progress and total duration
  current[win.id].progress = data.progress;
  current[win.id].duration = data.total;

  // reply to player
  event.sender.send('progress', data);
});

// fullscreen
ipcMain.on('fullscreen', (event, state) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // if the state should just switch, switch the current state
  const setState = (state === null)
  ? !current[win.id].fullscreen : state;

  // set current state
  current[win.id].fullscreen = setState;

  // make window fullscreen
  win.setFullScreen(setState);

  // reply to player
  event.sender.send('fullscreen', state);
});

// download
ipcMain.on('player-download', (event, id) => {
  torrents[id].makeDownload();
});

// when download button on movie is pressed
ipcMain.on('download', (event, movie) => {
  // if the movie is already being played, stop that download
  if (torrents[movie.id] && !torrents[movie.id].download) {
    torrents[movie.id].end();
  }

  // if movie isn't already downloaded, download it
  // set DE progress bar if it is the only movie downloading
  if (store.get().complete.indexOf(movie.id.toString()) === -1) {
    torrents[movie.id] = torrent(movie, true, ipcMain);
  }
});

// when delete button on movie is pressed
ipcMain.on('delete', (event, movie) => {
  // end download if it's downloading
  if (Object.keys(torrents).indexOf(movie.id.toString()) !== -1) {
    torrents[movie.id.toString()].end();
    store.remove(movie.id);
    delete torrents[movie.id.toString()];
  }

  // remove movie if it's already downloaded
  if (store.get().complete.indexOf(movie.id.toString()) !== -1) {
    store.remove(movie.id);
  }
});

// REST API
// see API.md for documentation

// set playback state
api.post('/controls/playback/', ({ body: { state = null } }) => {
  setThumbar(state, BrowserWindow.getFocusedWindow());
  BrowserWindow.getFocusedWindow().webContents.send('playback', state);
});

// set volume
api.post('/controls/volume/', ({ body: { volume, update = true } }) => {
  BrowserWindow.getFocusedWindow().webContents.send('volume', { volume, update });
});

// set progress
api.post('/controls/progress/', ({ body: { progress, total, update = true } }) => {
  BrowserWindow.getFocusedWindow().webContents.send('progress', { progress, total, update });
});

// set fullscreen state
api.post('/controls/fullscreen/', ({ body: { state = null } }) => {
  const win = BrowserWindow.getFocusedWindow();
  const setState = (state === null) ? !current[win.id].fullscreen : state;
  current[win.id].fullscreen = setState;
  win.setFullScreen(setState);
  win.webContents.send('fullscreen', state);
});

// get currently playing info
api.get('/current/', (req, res) => {
  if (BrowserWindow.getFocusedWindow()) {
    res.json(current[BrowserWindow.getFocusedWindow().id]);
  } else {
    res.json({});
  }
});

// get library
api.get('/library/', (req, res) => {
  store.reload();
  res.json(store.get());
});

// stream movie to player
api.all('/stream/:id', (req, res) => {
  // if movie is downloaded, stream from download location
  if (store.get().complete.indexOf(req.params.id) !== -1) {
    const file = {
      name: `${req.params.id}.${store.getFormat(req.params.id)}`,
      path: path.join(libraryLocation, `${req.params.id}.${store.getFormat(req.params.id)}`),
      length: fs.statSync(path.join(libraryLocation, `${req.params.id}.${store.getFormat(req.params.id)}`)).size,
    };

    // range of bytes to return
    let range = req.headers.range;
    range = range && rangeParser(file.length, range)[0];
    res.setHeader('Accept-Ranges', 'bytes');

    // set type based on file
    res.type(file.name);
    req.connection.setTimeout(3600000);

    if (!range) {
      res.setHeader('Content-Length', file.length);
      if (req.method === 'HEAD') {
        return res.end();
      }
      return pump(fs.createReadStream(file.path, { start: range.start, end: range.end }), res);
    }

    res.statusCode = 206;
    res.setHeader('Content-Length', (range.end - range.start) + 1);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.length}`);

    if (req.method === 'HEAD') {
      return res.end();
    }
    pump(fs.createReadStream(file.path, { start: range.start, end: range.end }), res);
  } else {
    // movie isn't downloaded

    // if movie isn't downloading, send 404
    if (Object.keys(torrents).indexOf(req.params.id) === -1) {
      return res.sendStatus(404);
    }

    // set file from downloading torrent
    const file = torrents[req.params.id].file;

    // range of bytes to send
    let range = req.headers.range;
    range = range && rangeParser(file.length, range)[0];
    res.setHeader('Accept-Ranges', 'bytes');

    // set type based on file
    res.type(file.name);
    req.connection.setTimeout(3600000);

    if (!range) {
      res.setHeader('Content-Length', file.length);
      if (req.method === 'HEAD') {
        return res.end();
      }
      return pump(file.createReadStream(), res);
    }

    res.statusCode = 206;
    res.setHeader('Content-Length', (range.end - range.start) + 1);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.length}`);

    if (req.method === 'HEAD') {
      return res.end();
    }
    pump(file.createReadStream(range), res);
  }

  // not needed, just to satisfy consistent return
  return false;
});

// listen on the port set in config
api.listen(streamPort);
