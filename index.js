const Twitter = require('twitter');
const Telegraf = require('telegraf');
const { OAuth } = require('oauth');
const emoji = require('emoji-aware');
const Koa = require('koa');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const config = require('./config.json');

const bot = new Telegraf(config.telegramBotToken);
const oa = new OAuth(
    'https://twitter.com/oauth/request_token',
    'https://twitter.com/oauth/access_token',
    config.twitterConsumerKey,
    config.twitterConsumerSecret,
    '1.0A',
    `http://${ config.serverIp }/`,
    'HMAC-SHA1'
);
const srv = new Koa();
const msgOptions = {
    parse_mode: 'HTML',
    disable_web_page_preview: true
};
const rl = readline.createInterface(process.stdin);

const secretTemp = {}; // { [requestToken]: { chatId, secret: requestSecret } }
const sessions = {};   // { [chatId]: { token, secret, client, lastId, task, ... } }
const sessionStorePath = path.join(__dirname, 'session.json');

/**
 * Load saved session.
 */
if (fs.existsSync(sessionStorePath)) {
    try {
        Object.assign(sessions, JSON.parse(fs.readFileSync(sessionStorePath)));

        for (let chatId in sessions) {
            let session = sessions[chatId];

            session.client = new Twitter({
                consumer_key: config.twitterConsumerKey,
                consumer_secret: config.twitterConsumerSecret,
                access_token_key: session.token,
                access_token_secret: session.secret
            });
            session.task = setInterval(update.bind(null, chatId), 60000);
            process.nextTick(update.bind(null, chatId));
        }
        console.log(`Loaded ${ Object.keys(sessions).length } session(s).`)
    } catch (e) {
        console.error('Failed to load json sessions:', e)
    }
}

/**
 * Signal handling.
 */
process.on('uncaughtException', console.error);
process.on('unhandledRejection', (e) => { throw e });
process.on('SIGINT', () => {
    if (Object.keys(sessions).length) {
        for (let key in sessions) {
            delete sessions[key].client;
            delete sessions[key].task;
        }
        fs.writeFileSync(sessionStorePath, JSON.stringify(sessions, null, 4));
        console.log(`Saved ${ Object.keys(sessions).length } session(s). Quitting...`);
    }
    process.exit(0);
});

/**
 * Authentication - Step 1
 */
bot.start((ctx) => {
    if (sessions[ctx.message.chat.id]) {
        ctx.reply('You have already started.');
        return;
    }
    oa.getOAuthRequestToken((error, key, secret) => {
        if (error) {
            console.log(error);
            ctx.reply('Error fetching OAuth Token.');
        } else {
            let { username } = ctx.message.from;
            secretTemp[key] = {
                secret,
                chatId: ctx.message.chat.id,
                username
            };
            ctx.reply(`<a href="https://api.twitter.com/oauth/authenticate?oauth_token=${ key }">Sign in with Twitter</a>`, msgOptions);
            console.log(`New user: @${ username } is authenticating...`);
        }
    });
});

/**
 * Authentication - Step 2
 */
srv.use(async (ctx, next) => {
    let { oauth_token: tempToken, oauth_verifier: code } = ctx.query;
    if (!tempToken || !code) ctx.throw(400);

    await new Promise((resolve) => {
        let { chatId, secret: tempSecret, username } = secretTemp[tempToken];
        delete secretTemp[tempToken];
        
        oa.getOAuthAccessToken(tempToken, tempSecret, code, (error, token, secret) => {
            if (error) {
                console.log(error);
                ctx.body = 'Error fetching OAuth Token.';
            } else {
                sessions[chatId] = {
                    username,
                    token, secret,
                    client: new Twitter({
                        consumer_key: config.twitterConsumerKey,
                        consumer_secret: config.twitterConsumerSecret,
                        access_token_key: token,
                        access_token_secret: secret
                    }),
                    lastId: null,
                    task: setInterval(update.bind(null, chatId), 60000),
                    recent: {}
                }
                process.nextTick(update.bind(null, chatId));

                ctx.redirect('https://t.me/rikumi_bot');
                console.log(`New user: @${ username } is signed in!`);
                resolve();
            }
        });
    });
});

/**
 * Scheduled action to update tweets for a user.
 * 
 * Normal frequency: 1 time per minute.
 * Twitter restrictions: 15 times per 15 minutes.
 */
function update(chatId) {
    let session = sessions[chatId];
    const options = {};
    if (!session.lastId) {
        options.count = 20;
    } else {
        options.since_id = session.lastId;
    }
    console.log(`Updating tweets for @${ session.username }.`);
    
    session.client.get('statuses/home_timeline', options, async (error, tweets) => {
        if (error) {
            console.log(`Error from @${ session.username }:`, error);
        } else {
            tweets = tweets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            try {
                for (let tweet of tweets) {
                    await sendTweet(chatId, tweet);
                    session.lastId = tweet.id_str;
                }
                console.log(`Updated ${ tweets.length } tweet(s) for @${ session.username }.`);
            } catch (e) {
                if (e && e.code === 403) {
                    clearInterval(session.task);
                    delete sessions[chatId];
                    console.log(`User has left: @${ session.username }.`);
                } else {
                    console.error(`Error from @${ session.username }:`, e)
                }
            }
        }
    });
}

/**
 * Transform and send a tweet to a user.
 */
async function sendTweet(chatId, tweet) {
    let session = sessions[chatId];
    let { mediaType, mediaUrls, text } = buildTweet(tweet);
    let result;

    let options = { ...msgOptions };

    /**
     * Search the replied tweet in the 100 messages recently sent to the user.
     * Once found, the message will quote the previous message of the replied tweet to provide more dialog context.
     */
    let replied = tweet.in_reply_to_status_id_str;
    if (replied && session.recent[replied]) {
        options.reply_to_message_id = session.recent[replied];
    }

    switch (mediaType) {
        case 'photo':
            if (mediaUrls.length > 1) {
                /**
                 * Send multiple photos in a media group.
                 * Telegram media groups do not have a explicit caption. Instead, send the media group in advance,
                 * and then quote it in another message carrying the tweet content.
                 */
                let [pic] = await bot.telegram.sendMediaGroup(chatId, mediaUrls.map(url => ({ type: 'photo', media: url })));
                options.reply_to_message_id = pic.message_id;
                result = await bot.telegram.sendMessage(chatId, text, options);
            } else {
                options.caption = text;
                result = await bot.telegram.sendPhoto(chatId, mediaUrls[0], options);
            }
            break;
        case 'video':
            options.caption = text;
            result = await bot.telegram.sendVideo(chatId, mediaUrls[0], options);
            break;
        case 'animated_gif':
            options.caption = text;
            result = await bot.telegram.sendAnimation(chatId, mediaUrls[0], options);
            break;
        default:
            result = await bot.telegram.sendMessage(chatId, text, options);
    }
    
    /**
     * Maintain mappings from tweet id's to message id's of 100 tweets recently sent to the user.
     */
    session.recent = session.recent || {};
    let recentTweets = Object.keys(session.recent);
    if (recentTweets.length > 100) {
        recentTweets.sort().slice(0, -100).forEach(k => { delete session.recent[k] });
    }
    session.recent[tweet.id_str] = Array.isArray(result) ? result[0].message_id : result.message_id;
}

/**
 * Transform a tweet into readable HTML string.
 */
function buildTweet(tweet) {
    let {
        user, text, entities, extended_entities = {},
        in_reply_to_status_id_str: replied,
        retweeted_status: retweeted,
        quoted_status: quoted
    } = tweet;

    let { hashtags, user_mentions: mentions, urls } = entities;

    /**
     * According to Twitter documentation, the `entities` always use 'photo' as the media type which may be incorrect.
     * In most cases, `extended_entities` should be used instead of `entities` to get the media.
     */ 
    let { media = [] } = extended_entities;

    // There is only one type of media in a single tweet.
    let mediaType = media[0] && media[0].type;
    let mediaUrls = [];

    /**
     * For retweeted tweet, build the whole tweet into string, add 'RT\n' in front,
     * and use it nestedly as the content. This will produce the format like:
     * 
     * ♻️ <Retweeter name>: RT
     * 🐦 <Tweeter name>: tweet content
     */
    if (retweeted) {
        try {
            let that = buildTweet(retweeted);
            mediaType = that.mediaType;
            mediaUrls = that.mediaUrls;
            text = 'RT\n' + that.text;
        } catch (e) {}
    } else {
        let isPoll = false;

        entities = [
            ...hashtags.map(k => Object.assign(k, { entityType: 'hashtag' })),
            ...mentions.map(k => Object.assign(k, { entityType: 'mention' })),
            ...media.map(k => Object.assign(k, { entityType: 'media' })),
            ...urls.map(k => Object.assign(k, { entityType: 'url' })),

            // Escapable characters are also considered entity ranges, in order to be properly replaced.
            // Note that Twitter entity ranges are emoji-aware and inclusive.
            // Being emoji-aware means a complex emoji combined by multiple Unicode characters is considered one character.
            ...emoji.split(text)
                .map((ch, i) => ({ ch, i }))
                .filter(({ ch }) => ~'<>&'.indexOf(ch))
                .map(({ ch, i }) => ({
                    entityType: 'escapable',
                    indices: [i, i], // inclusive
                    replacement: {
                        '<': '&lt;',
                        '>': '&gt;',
                        '&': '&amp;'
                    }[ch]
                }))
        ];

        /**
         * Entity ranges are sorted by their ending indices and replaced in descending order.
         * This can ensure each range remains correct before its replacement.
         */
        entities = entities.sort((a, b) => b.indices[1] - a.indices[1]);

        let indicesValidBefore = Math.min(); // Max value

        for (let entity of entities) {
            let { entityType, indices: [from, to] } = entity;
            let replaceText = '';

            switch (entityType) {
                case 'escapable':
                    replaceText = entity.replacement;
                    break;
                case 'mention':
                    let { name, screen_name } = entity;
                    replaceText = `<a href="https://twitter.com/${ screen_name }">@${ name }</a> `;
                    break;
                case 'hashtag':
                    let { text } = entity;
                    replaceText = `<a href="https://twitter.com/hashtag/${ text }">#${ text }</a> `;
                    break;
                case 'url':
                    let { expanded_url, display_url } = entity;
                    if (quoted && new RegExp(quoted.id_str + '/?$').test(expanded_url)) {
                        replaceText = '';
                    } else {
                        replaceText = `<a href="${ expanded_url }">${ display_url }</a> `;
                    }
                    break;
                case 'media':
                    if (mediaType === 'video' || mediaType === 'animated_gif') {
                        let sources = entity.video_info.variants
                            .map(k => { k.bitrate = k.bitrate || 0; return k })
                            .sort((a, b) => b.bitrate - a.bitrate);
                        mediaUrls.push(sources[Math.floor(sources.length / 2)]).url;
                    } else {
                        mediaUrls.push(entity.media_url_https);
                    }
                    replaceText = '';
                    break;
                case 'poll':
                    isPoll = true;
                    break;
            }

            /**
             * An entity is replaced only when its range is correct,
             * in other words, its range hasn't been covered by previously replaced entities.
             * Otherwise, this entity is considered dirty and should not be replaced to prevent potential UTF-8 problems.
             */
            if (indicesValidBefore > to) {
                // Again, Twitter entity ranges are emoji-aware and inclusive.
                let arr = emoji.split(text);
                arr.splice(from, to - from + 1, replaceText);
                text = arr.join('');
                indicesValidBefore = from;
            }
        }

        // Clean up leading user mentions (commonly seen in replies).
        text = text.replace(/^(<a [^>]*>@[^<]*<\/a>\s*)+/, '').trim();

        // Append badges like `[photo]` `[video]` to empty tweets with media.
        if (mediaType && /<\/a>\s*:$/.test(text)) {
            text += ` [${ /\w+$/.exec(mediaType)[0] }]`;
        }

        // Append badges `[poll]` to empty tweets with poll.
        if (isPoll) {
            text += ` [poll]`;
        }

        // Append the quoted tweet (if exists) below the main tweet.
        if (quoted) {
            try {
                let that = buildTweet(quoted)
                if (!mediaType) {
                    mediaType = that.mediaType;
                    mediaUrls = that.mediaUrls;
                }
                text += '\n' + that.text;
            } catch (e) {}
        }
    }

    return {
        mediaType,
        mediaUrls,
        text: `<a href="https://twitter.com/${ tweet.user.screen_name }/status/${ tweet.id_str }">${
            retweeted || quoted ? '♻️' : (replied ? '💬' : '🐦')
        } ${ user.name }</a>: ${ text }`
    };
}

/**
 * Bot incoming message handler for:
 * 
 * - tweeting
 * - retweeting via Telegram forwarded messages, or
 * - replying via Telegram replies.
 */
bot.on('message', (ctx) => {
    let { message } = ctx;
    let session = sessions[message.chat.id];
    let originalMessage = message.reply_to_message || message;
    let originalEntities = originalMessage.entities || originalMessage.caption_entities || [];
    
    let tweetId = originalEntities.find(k => {
        return k.url && k.offset === 0 && /^https?:\/\/(?:twitter.com|t.co)\/[^\/]+\/status\/(\d+)$/.test(k.url);
    }) && RegExp.$1;

    if (tweetId && !message.reply_to_message) {
        if (message.forward_from) { // Forward
            session.client.post('statuses/retweet/' + tweetId, (error, res) => {
                if (error) {
                    error = error[0] || error;
                    ctx.reply(`Error retweeting: (${ error.code }) ${ error.message }`);
                } else {
                    ctx.reply('Retweeted!');
                }
            });
        } else { // Copied content, may have changed
            ctx.reply('Error: You should forward a message in a native manner provided by Telegram. \n' + 
                'Otherwise, we cannot distinguish whether you have added your own content.');
        }
    } else if (message.photo || message.video) {
        ctx.reply('Error: Photos and videos are not allowed in order to prevent server pressure.');
    } else if (message.reply_to_message && !tweetId) {
        ctx.reply('Error: The replied message is not from Twitter.');
    } else if (!message.text) {
        ctx.reply('Error: You must specify the text content for tweets and replies.');
    } else {
        session.client.post('statuses/update', {
            status: message.text,
            in_reply_to_status_id: tweetId || undefined
        }, async (error, res) => {
            if (error) {
                error = error[0] || error;
                ctx.reply(`Error tweeting: (${ error.code }) ${ error.message }`);
            } else {
                await ctx.reply(tweetId ? 'Replied!' : 'Tweeted!');
                update(message.chat.id);
            }
        });
    }    
});

// Receiving contents from the console and broadcast the message to every user.
rl.on('line', async (msg) => {
    msg = msg.trim();
    if (msg) {
        try {
            await Promise.all(Object.keys(sessions).map(chatId => bot.telegram.sendMessage(chatId, msg, { ...msgOptions })));
        } catch (e) {
            console.error(e);
        }
        console.log('Sent to all chats.')
    }
});

bot.launch();
srv.listen(80);