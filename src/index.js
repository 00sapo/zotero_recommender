#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import open from 'open';

const sqlite3 = require('sqlite3').verbose();
const { get: _get, post } = require('axios');
const blessed = require('blessed');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const ProgressBar = require('progress');

const argv = yargs(hideBin(process.argv))
  .option('zoteroDbPath', {
    describe: 'Path to the Zotero database (usually zotero.sqlite)',
    default: join(homedir(), "Zotero", "zotero.sqlite")
  })
  .option('cachePath', {
    describe: 'Path to the cache',
    default: join(homedir(), "Zotero", "zotero_cache")
  })
  .option('s2ApiKey', {
    describe: 'Semantic Scholar API key (if not used, the public rate limiting applies)',
    default: process.env.S2_API_KEY
  })
  .option('resultLimit', {
    describe: 'Limit of results to return from Semantic Scholar',
    default: 10
  })
  .option('inputPapers', {
    describe: 'Number of input papers (maximum allowed by SemanticScholar is 100). If the selected papers are more than this number, a random selection will be made.',
    default: 100
  })
  .option('forceUpdate', {
    describe: 'Force update of data that has no match found in Semantic Scholar',
    default: false,
    boolean: true
  })
  .option('collection', {
    describe: 'Name of a collection',
    default: null
    // default: 'Soundscapes'
  })
  .option('includeSubcollection', {
    describe: 'Include subcollections',
    default: true,
    boolean: true
  })
  .option('light', {
    describe: 'Turn on the light (theme)',
    default: false,
    boolean: true
  })
  .option('json', {
    describe: 'Output the results as JSON',
    default: false,
    boolean: true
  })
  .help()
  .argv;

const ZOTERO_DB_PATH = argv.zoteroDbPath;
const CACHE_PATH = argv.cachePath;
const S2_API_KEY = argv.s2ApiKey;
const RESULT_LIMIT = argv.resultLimit;
const INPUT_PAPERS = argv.inputPapers;
const FORCE_UPDATE = argv.forceUpdate;
const COLLECTION = argv.collection;
const INCLUDE_SUBCOLLECTION = argv.includeSubcollection;
const LIGHT = argv.light;
const JSON_OUTPUT = argv.json;

class Cache {
  static path = join(CACHE_PATH, "paper_ids.json");
  constructor() {
    this._cache = {};
  }

  static from_file() {
    let obj = new Cache();
    obj._cache = JSON.parse(readFileSync(Cache.path, 'utf8'));
    return obj;
  }

  to_file() {
    writeFileSync(Cache.path, JSON.stringify(this._cache));
  }

  contains(key) {
    return key in this._cache;
  }

  get(key) {
    return this._cache[key];
  }

  set(key, value) {
    this._cache[key] = value;
    this.to_file();
  }
}

/**
 * @param {string} query
 * @returns {Promise<Array<Object>>}
 */
async function zotero_query(query) {
  let db = new sqlite3.Database(ZOTERO_DB_PATH, sqlite3.OPEN_READONLY);
  let answer = await new Promise((resolve, reject) => {
    db.all(query, [], (err, rows) => {
      if (err) {
        reject(err);
      }
      resolve(rows);
    });
  });
  db.close();
  return answer;
}

/**
* @param {string} title
* @returns {Promise<string>}
*/
async function request_paper_id(title) {
  try {
    let response = await _get(
      "https://api.semanticscholar.org/graph/v1/paper/search/match",
      {
        headers: { "X-API-KEY": S2_API_KEY },
        params: { "query": title }
      }
    );
    let results = response.data;
    let paper_id = results["data"][0]["paperId"];
    return paper_id;
  } catch (error) {
    console.error(`\nError searching for "\x1b[3m${title}\x1b[23m":\n\t${error}, ${error.response.data.error}`);
    return null;
  }
}

/**
  * Look for the papers from Zotero in Semantic Scholar.
  * Uses a cache to store the results and avoid repeated requests.
  * @param {Array<string>} titles
  * @param {Cache} cache
  * @returns {Promise<Array<string>>}
  */
async function match_papers(titles, cache) {
  let papers = [];

  var bar;
  if (!JSON_OUTPUT) {
    // Create a progress bar
    bar = new ProgressBar(':bar :percent', { total: titles.length })
    console.log(`Searching for ${titles.length} papers in Semantic Scholar.`);
  }
  for (let title of titles) {
    let paper_id;
    if (cache.contains(title)) {
      if (cache.get(title) === null && FORCE_UPDATE) {
        paper_id = await request_paper_id(title);
      } else {
        paper_id = cache.get(title);
      }
    } else {
      paper_id = await request_paper_id(title);
    }

    cache.set(title, paper_id);
    if (paper_id !== null) {
      papers.push(paper_id);
    }
    // Update the progress bar
    if (!JSON_OUTPUT)
      bar.tick();
  }
  return papers;
}

/**
  * Request recommendations for a list of papers.
  * Returns a list of recommended papers.
  * @param {string} papers 
  * @returns {Promise<Array<Object>>}
  */
async function find_recommendations(papers) {
  if (!JSON_OUTPUT)
    console.log(`Requesting ${RESULT_LIMIT} recommendations for ${papers.length} papers.`);
  if (papers.length > INPUT_PAPERS) {
    if (!JSON_OUTPUT) {
      console.log(`Warning: requesting recommendations for more than ${INPUT_PAPERS} papers.`);
      console.log(`SemanticScholar API supports up to ${INPUT_PAPERS} papers.`);
      console.log(`Randomly selecting ${INPUT_PAPERS} papers.`);
    }
    papers = papers.slice(0, INPUT_PAPERS);
  }

  try {
    let response = await post(
      "https://api.semanticscholar.org/recommendations/v1/papers/",
      { "positivePaperIds": papers },
      {
        headers: { "X-API-KEY": S2_API_KEY },
        params: {
          "fields": "title,authors,url,year,abstract,influentialCitationCount,citationCount",
          "limit": RESULT_LIMIT,
        }
      }
    );
    let results = response.data;
    return results["recommendedPapers"]
  } catch (error) {
    console.error(`Error requesting recommendations: ${error}`);
  }
}

/**
 * Print the papers in a nice format using blessed.
 * When pressing enter on a paper, it should open the paper in the browser.
 * @param {Array<Object>} papers
 */
function print_papers(papers) {
  // Create a screen object.
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Semantic Scholar Recommendations',
  });

  // Create a list box for paper titles.
  const list = blessed.list({
    top: '0',
    left: '0',
    width: '30%',
    height: '100%',
    keys: true,
    vi: true,
    style: {
      selected: {
        bg: 'green',
        fg: 'black',
      },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
      inverse: true,
    },
    search: function (callback) {
      prompt.input('Search:', '', function (err, value) {
        if (err) return;
        return callback(null, value);
      });
    }
  });

  // Add paper titles to the list.
  papers.forEach((paper) => {
    list.addItem(paper.title);
  });

  // Create a box to display the selected paper details.
  const detailBox = blessed.box({
    top: '0',
    left: '30%',
    width: '70%',
    height: '100%',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'white',
      },
      scrollbar: {
        bg: 'blue',
      },
    },
    scrollbar: {
      ch: ' ',
      track: {
        bg: 'grey',
      },
      style: {
        inverse: true,
      },
    },
  });

  // Update the detail box content based on the selected item.
  function updateDetailBox(index) {
    const paper = papers[index];

    const authorList = paper.authors.map(a => a.name).join(', ');
    const content = `{bold}${paper.title}{/bold}\n${authorList}\n${paper.year}\nCitations: ${paper.citationCount}, Influential: ${paper.influentialCitationCount}\n\n${paper.abstract}\n`;
    detailBox.setContent(content);
    screen.render();
  }

  // Initial update for the first item.
  updateDetailBox(0);

  list.on('select item', function (_, index) {
    updateDetailBox(index);
  });

  // Handle enter key to open the selected paper in the browser.
  list.key(['enter'], function () {
    const selected = list.selected;
    const paper = papers[selected];
    open(paper.url);
  });

  // Quit on Escape, q, or Control-C.
  screen.key(['escape', 'q', 'C-c'], function () {
    return process.exit(0);
  });

  // Focus on the list.
  list.focus();

  // Append elements to the screen.
  screen.append(list);
  screen.append(detailBox);

  // Render the screen.
  screen.render();
}

function buildList(collections, parentCollectionID = null, level = 0) {
  let list = [];
  collections
    .filter(c => c.parentCollectionID === parentCollectionID)
    .sort((a, b) => a.collectionName.localeCompare(b.collectionName))
    .forEach(c => {
      list.push(' '.repeat(level * 2) + c.collectionName);
      list = list.concat(buildList(collections, c.collectionID, level + 1));
    });
  return list;
}

/**
  * Let pick a collection by selecting it with the arrows
  * Uses blessed to created the navigable tree
  * Returns the collection ID
  */
function pick_collection() {
  return new Promise(async (resolve, _) => {

    const screen = blessed.screen();
    const collections = await zotero_query("select collectionID,collectionName,parentCollectionID from collections");

    let list = blessed.list({
      parent: screen,
      mouse: true,
      keys: true,
      vi: true,
      style: {
        selected: {
          bg: LIGHT ? 'black' : 'green',
          fg: LIGHT ? 'green' : 'black'
        }
      },
      search: function (callback) {
        const prompt = blessed.prompt({
          parent: screen,
          top: 'center',
          left: 'center',
          height: 'shrink',
          width: 'shrink',
          border: 'line',
        });

        prompt.input('Search:', '', function (err, value) {
          if (err) return;
          return callback(null, value);
        });
      },
      items: buildList(collections),
    });

    list.on('select', (data) => {
      screen.destroy();
      resolve(data.content.trim());
    });

    screen.key(['escape', 'q', 'C-c'], function (ch, key) {
      return process.exit(0);
    });

    screen.render();
  });
}

/**
  * Construct the query to get the titles.
  * If collection is null, it will ask the user to select a collection.
  */
async function get_base_query(collection, include_subcollection) {
  if (collection === null) {
    collection = await pick_collection();
  }
  let base_query = `select distinct itemDataValues.value 
  from itemDataValues 
  join itemData on itemDataValues.valueID = itemData.valueID 
  join items on items.itemID = itemData.itemID 
  join itemTypes on items.itemTypeID = itemTypes.itemTypeID
  join collectionItems on collectionItems.itemID = items.itemID 
  join collections on collections.collectionID = collectionItems.collectionID
  where itemData.fieldID = 1 
  and itemTypes.typeName in ('report', 'thesis', 'book', 'bookSection', 'manuscript', 'conferencePaper', 'journalArticle', 'manuscript', 'document', 'preprint', 'document')
  and items.itemID NOT IN (select itemID from deletedItems)`;

  if (collection && include_subcollection) {
    base_query += ` and (collections.collectionName = "${collection}"
  OR collections.parentCollectionID = (SELECT collections.collectionID 
    FROM collectionItems 
    JOIN collections ON collectionItems.collectionID = collections.collectionID 
    WHERE collectionName = "${collection}")
    )`;
  } else if (collection && !include_subcollection) {
    base_query += ` and collections.collectionName = "${collection}" `;
  }
  return base_query;
}


async function main() {
  const base_query = await get_base_query(COLLECTION, INCLUDE_SUBCOLLECTION);
  const titles = await zotero_query(base_query).then(titles => titles.map(t => t.value));

  let cache;
  if (existsSync(Cache.path)) {
    cache = Cache.from_file();
  } else {
    cache = new Cache();
  }

  let papers = await match_papers(titles, cache);
  if (papers.length === 0) {
    if (!JSON_OUTPUT)
      console.log("No papers found in Semantic Scholar")
    return
  }
  const recommendations = await find_recommendations(papers);
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(recommendations, null, 2));
  } else {
    print_papers(recommendations);
  }
}


await main();
