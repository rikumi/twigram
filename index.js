const Twitter = require('twitter');
const Telegraf = require('telegraf');
const { OAuth } = require('oauth');
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

bot.start((ctx) => {
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

async function sendTweet(chatId, tweet) {
    let session = sessions[chatId];
    let { mediaType, mediaUrls, text } = buildTweet(tweet);
    let result;

    let options = { ...msgOptions };

    let replied = tweet.in_reply_to_status_id_str;
    if (replied && session.recent[replied]) {
        options.reply_to_message_id = session.recent[replied];
    }

    switch (mediaType) {
        case 'photo':
            if (mediaUrls.length > 1) {
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

    session.recent = session.recent || {};
    let recentTweets = Object.keys(session.recent);
    if (recentTweets.length > 100) {
        recentTweets.sort().slice(0, -100).forEach(k => { delete session.recent[k] });
    }
    session.recent[tweet.id_str] = Array.isArray(result) ? result[0].message_id : result.message_id;
}

function buildTweet(tweet) {
    let { user, text, entities, extended_entities = {} } = tweet;
    let { hashtags, user_mentions: mentions, urls } = entities;
    let { media = [] } = extended_entities;
    let mediaType = media[0] && media[0].type;

    entities = [
        ...hashtags.map(k => Object.assign(k, { entityType: 'hashtag' })),
        ...mentions.map(k => Object.assign(k, { entityType: 'mention' })),
        ...media.map(k => Object.assign(k, { entityType: 'media' })),
        ...urls.map(k => Object.assign(k, { entityType: 'url' }))
    ].sort((a, b) => b.indices[0] - a.indices[0]);

    let processedUpTo = Math.min();
    let mediaUrls = [];
    for (let entity of entities) {
        let { entityType, indices: [from, to] } = entity;
        let replaceText = '';

        switch (entityType) {
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
                replaceText = `<a href="${ expanded_url }">${ display_url }</a> `;
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
        }

        if (processedUpTo >= to) {
            let arr = text.split('');
            arr.splice(from, to - from + 1, replaceText);
            text = arr.join('');
            processedUpTo = from;
        }
    }

    text = text.replace(/^(<a [^>]*>@[^<]*<\/a>\s*)+/, '').trim();

    if (mediaType && /<\/a>\s*:$/.test(text)) {
        text += ` [${ /\w+$/.exec(mediaType)[0] }]`;
    }

    return {
        mediaType,
        mediaUrls,
        text: `<a href="https://twitter.com/${ tweet.user.screen_name }/status/${ tweet.id_str }">${ tweet.in_reply_to_status_id_str ? '💬' : '🔗' }${ user.name }</a>: ${ text }`
    }
}

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
})

bot.launch();
srv.listen(80);